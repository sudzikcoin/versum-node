/**
 * Script jobs WITHOUT Docker (v0.4.0, 2026-10-25): the Windows and macOS node runs `kind: python` jobs
 * with the Python interpreter it ships (python-build-standalone, under <app>/python) inside the operating
 * system's own sandbox. Nothing is installed, nothing needs an administrator, no VM, no WSL.
 *
 *   Windows   versum-sandbox.exe (packaging/windows/sandbox/Sandbox.cs, built with the in-box C# compiler)
 *             starts the interpreter in an AppContainer created for that one attempt — a low-box token with
 *             ZERO capabilities: no network (not even loopback), no access to the user's files (only what is
 *             granted to the container's own SID: the attempt's directory, read-execute on the Python tree and
 *             on the system directories every package may read), no registry writes, no other processes.
 *             A Job Object on top: memory ceiling, CPU rate cap, process count, kill-on-close, cpu accounting.
 *   macOS     /usr/bin/sandbox-exec with a generated Seatbelt profile: deny by default, no network at all,
 *             read the Python tree and the system, read-write ONLY the attempt's directory, nothing under
 *             /Users or /Volumes. `ulimit -t` caps CPU seconds, `ulimit -f` caps a file's size, `nice` lowers
 *             priority, the RSS of the process group is polled and the group is killed over the memory limit.
 *   both      the time limit kills, a stall kills, a disk-usage poll kills, the directory is wiped afterwards.
 *
 * What a native node will NOT run (fitsNative): container jobs, GPU jobs, jobs that need the network — those
 * need a container node (Linux / Docker). The hub's scheduler does not offer them (executor_kind), and the
 * node refuses them anyway.
 *
 * Pure: nativeCommand, nativeEnv, fitsNative, sandboxProfile, parsePs, cpuTimeToSeconds, probeVerdict.
 * Everything that touches the machine lives in createNativeExecutor() and detectNative().
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
import { join, dirname, win32, posix } from 'node:path'
const pathFor = (platform) => (platform === 'win32' ? win32 : posix)
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const PYTHON_DIR = 'python'
export const SANDBOX_EXE = 'versum-sandbox.exe'
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
export const NATIVE_KINDS = ['python']
export const TMP_DIR = 'tmp'

/** The interpreter inside a python-build-standalone tree, by platform; null when the tree is not there. */
export function pythonExe(dir, platform = process.platform) {
  if (!dir) return null
  const exe = platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3')
  return existsSync(exe) ? exe : null
}

/** Where the Python tree is: VERSUM_NODE_PYTHON (a directory) or <appRoot>/python. */
export function findPython({ appRoot, env = process.env, platform = process.platform }) {
  for (const dir of [env.VERSUM_NODE_PYTHON, appRoot ? join(appRoot, PYTHON_DIR) : null]) {
    const exe = pythonExe(dir, platform)
    if (exe) return { dir, exe }
  }
  return null
}

/** Pure: why this node will not run the manifest, or null. A native node runs python scripts, offline, on the CPU. */
export function fitsNative(manifest) {
  if (!NATIVE_KINDS.includes(manifest.kind)) return `this node runs python scripts only (no container runtime); kind ${manifest.kind} needs a container node`
  if (manifest.limits.gpu) return 'GPU jobs need a container node (Linux / Docker); this node has no GPU sandbox'
  if (manifest.limits.network) return 'jobs with network need a container node; the sandbox on this node has no network at all'
  const first = manifest.command[0]
  if (first !== 'python' && first !== 'python3') return `command must start with python; got ${JSON.stringify(first)}`
  return null
}

/** Pure: a container path (/job, /job/in/x) → a path under the attempt's directory; anything else untouched. */
export function mapJobPath(arg, jobDir, platform = process.platform) {
  if (arg === '/job') return jobDir
  if (!arg.startsWith('/job/')) return arg
  const rest = arg.slice(5).split('/')
  if (rest.some((s) => s === '..' || s === '')) return arg
  return pathFor(platform).join(jobDir, ...rest)
}

/**
 * Pure: the argv the sandbox runs. The hub's `["python", "/job/in/main.py", …]` becomes the embedded interpreter
 * in isolated mode (-E no PYTHON* env, -s no user site, -B no .pyc, -u unbuffered so PROGRESS lines arrive,
 * -X utf8) and every /job path is the real directory. The script's own directory stays on sys.path (a buyer may
 * ship a helper module beside the script), which is why -I is not used.
 */
export function nativeCommand(manifest, { jobDir, python, platform = process.platform }) {
  const why = fitsNative(manifest)
  if (why) throw new Error(why)
  return [python, '-E', '-s', '-B', '-u', '-X', 'utf8', ...manifest.command.slice(1).map((a) => mapJobPath(a, jobDir, platform))]
}

/**
 * Pure: the environment of the interpreter. Nothing from this process: a fixed base per platform (PATH is the
 * Python tree only, every temp/home variable points INTO the attempt's directory), then the buyer's env, then
 * the VERSUM_* facts and the Python switches, which the buyer cannot override.
 */
export function nativeEnv(manifest, { jobDir, pythonDir, platform = process.platform, hostEnv = {} }) {
  const P = pathFor(platform)
  const tmp = P.join(jobDir, TMP_DIR)
  const base = platform === 'win32'
    ? {
        SYSTEMROOT: hostEnv.SYSTEMROOT ?? hostEnv.SystemRoot ?? 'C:\\Windows', WINDIR: hostEnv.WINDIR ?? hostEnv.windir ?? 'C:\\Windows',
        PATH: pythonDir, PATHEXT: '.EXE;.BAT;.CMD', TEMP: tmp, TMP: tmp, USERPROFILE: tmp, HOMEDRIVE: tmp.slice(0, 2), HOMEPATH: tmp.slice(2),
        LOCALAPPDATA: tmp, APPDATA: tmp, NUMBER_OF_PROCESSORS: String(manifest.limits.cpu_cores),
        ...(hostEnv.PROCESSOR_ARCHITECTURE ? { PROCESSOR_ARCHITECTURE: hostEnv.PROCESSOR_ARCHITECTURE } : {}),
      }
    : { PATH: P.join(pythonDir, 'bin'), HOME: tmp, TMPDIR: tmp, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SHELL: '/usr/bin/false' }
  return {
    ...manifest.env, ...base,
    VERSUM_JOB_ID: manifest.job_id, VERSUM_PIECE_ID: manifest.piece_id, VERSUM_ATTEMPT_ID: manifest.attempt_id,
    VERSUM_JOB_DIR: jobDir, VERSUM_JOB_IN: P.join(jobDir, 'in'), VERSUM_JOB_OUT: P.join(jobDir, 'out'),
    PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1',
  }
}

/* ───────────── macOS: the Seatbelt profile ───────────── */

const sbStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Pure: the sandbox-exec profile for one attempt. Later rules win, so: deny everything; allow what a Python
 * process needs from the system (read-only); deny every user path; then re-open exactly two trees — the Python
 * tree (read) and the attempt's directory (read-write). No network of any kind. No exec outside the Python tree.
 */
export function sandboxProfile({ jobDir, pythonDir, homeDir = null }) {
  void homeDir   // kept in the signature: the home is shut by deny-default, not by a rule that could shadow the job dir
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    `(allow process-exec (subpath ${sbStr(pythonDir)}))`,
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm)',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.SecurityServer"))',
    // stat() anywhere (path resolution, getcwd, realpath): names and sizes, never contents or listings
    '(allow file-read-metadata)',
    // the system, read-only. Nothing under /Users, /Volumes, /Library or /private/tmp is listed here, so deny-default keeps
    // them shut: no listing of /Users, no reading of the owner's home. The data volume is denied again by its firmlink
    // path so that /System/Volumes/Data/Users/… cannot stand in for /Users/… .
    '(allow file-read* (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/System") (subpath "/Library/Preferences/Logging") (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld") (subpath "/private/etc") (literal "/etc") (literal "/var") (literal "/tmp") (literal "/private") (literal "/private/var") (subpath "/dev") (literal "/"))',
    '(deny file-read* file-write* (subpath "/System/Volumes/Data"))',
    '(allow file-read-metadata (subpath "/System/Volumes/Data"))',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))',
    `(allow file-read* (subpath ${sbStr(pythonDir)}))`,
    `(allow file-read* file-write* (subpath ${sbStr(jobDir)}))`,
    '(deny network*)',
  ].join('\n') + '\n'
}

/** Pure: "mm:ss.cc", "hh:mm:ss", "d-hh:mm:ss" (ps cputime) → seconds. */
export function cpuTimeToSeconds(text) {
  const t = String(text).trim()
  if (!t) return 0
  let days = 0, rest = t
  const d = /^(\d+)-(.*)$/.exec(t)
  if (d) { days = Number(d[1]); rest = d[2] }
  const parts = rest.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  let s = 0
  for (const p of parts) s = s * 60 + p
  return days * 86400 + s
}

/** Pure: `ps -axo pgid=,rss=,cputime=` → the group's totals: rss in MB, cpu seconds, process count. */
export function parsePs(text, pgid) {
  let rssKb = 0, cpu = 0, processes = 0
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    if (!m || Number(m[1]) !== Number(pgid)) continue
    processes++; rssKb += Number(m[2]); cpu += cpuTimeToSeconds(m[3])
  }
  return { rssMb: rssKb / 1024, cpuSeconds: cpu, processes }
}

/** Bytes under a directory, regular files only, symlinks never followed. */
export function dirSizeBytes(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      try { if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(p); else if (e.isFile()) total += statSync(p).size } catch {}
    }
  }
  walk(dir)
  return total
}

/** Pure: the probe's result.json → { ok, failures[] }: every door the sandbox must keep shut, and whether it did. */
export function probeVerdict(result) {
  const r = result && typeof result === 'object' ? result : {}
  const must = { network_blocked: 'the job reached the network', loopback_blocked: 'the job reached 127.0.0.1', users_dir_blocked: 'the job could list the users directory', home_write_blocked: 'the job wrote outside its directory', out_write_ok: 'the job could not write its own out/ directory', cwd_ok: 'the job could not even read its own working directory' }
  const failures = Object.entries(must).filter(([k]) => r[k] !== true).map(([k, why]) => `${k}: ${why}`)
  return { ok: failures.length === 0, failures }
}

/* ───────────── detection ───────────── */

/**
 * Is the native sandbox usable here? Needs the Python tree, and on Windows versum-sandbox.exe that can create an
 * AppContainer, on macOS /usr/bin/sandbox-exec. Returns the same shape detectRuntime() does, with kind 'native'.
 */
export async function detectNative({ appRoot, env = process.env, platform = process.platform, exec = execFileP } = {}) {
  const reasons = []
  const out = { ok: false, kind: 'native', name: null, version: null, rootless: true, reasons, rt: null, python: null, helper: null, sandbox: null }
  if (platform !== 'win32' && platform !== 'darwin') { reasons.push('the native sandbox exists for Windows and macOS only; Linux nodes use Podman or Docker'); return out }
  const py = findPython({ appRoot, env, platform })
  if (!py) { reasons.push(`no embedded Python at ${appRoot ? join(appRoot, PYTHON_DIR) : '(no app root)'} (VERSUM_NODE_PYTHON can point at a python-build-standalone tree)`); return out }
  out.python = py
  try { const { stdout } = await exec(py.exe, ['-E', '-s', '-c', 'import sys;print(sys.version.split()[0])'], { timeout: 20_000, encoding: 'utf8' }); out.version = stdout.trim() || null }
  catch (e) { reasons.push(`the embedded Python does not start: ${String(e.message).split('\n')[0]}`); return out }
  if (platform === 'win32') {
    const helper = env.VERSUM_NODE_SANDBOX_EXE || join(appRoot ?? '', SANDBOX_EXE)
    if (!existsSync(helper)) { reasons.push(`${SANDBOX_EXE} is missing beside the node (${helper})`); return out }
    out.helper = helper
    try {
      const { stdout } = await exec(helper, ['probe'], { timeout: 30_000, encoding: 'utf8', windowsHide: true })
      const j = JSON.parse(stdout.trim().split('\n').pop())
      if (!j.appcontainer) { reasons.push(`AppContainer is not available on this Windows: ${j.error ?? 'unknown'}`); return out }
      out.sandbox = 'appcontainer'
    } catch (e) { reasons.push(`${SANDBOX_EXE} probe failed: ${String(e.stderr ?? e.message).trim().split('\n').pop()}`); return out }
  } else {
    if (!existsSync(SANDBOX_EXEC)) { reasons.push(`${SANDBOX_EXEC} is missing (it ships with every macOS)`); return out }
    out.sandbox = 'seatbelt'
  }
  out.ok = true
  out.name = 'sandbox'
  return out
}

/* ───────────── the executor ───────────── */

/**
 * The native executor the runner drives: prepare() (nothing to pull), start() (the sandboxed interpreter with
 * kill, cpuSeconds, memory and disk watch), cleanup() (profile gone, nothing of the attempt remains).
 * `sandbox: 'none'` runs the interpreter bare — reachable from tests only (never from config), so the executor's
 * plumbing can be tested on Linux where no sandbox exists.
 */
export function createNativeExecutor({ python, helper = null, sandbox, home, platform = process.platform, hostEnv = process.env, log = () => {}, ps = execFileP }) {
  const stateDir = join(home, 'state')
  const profilesList = join(stateDir, 'appcontainers.txt')
  return {
    kind: 'native', sandbox, python,
    mountPath: (jobDir) => jobDir,
    async prepare() { /* nothing to pull: the interpreter is already here */ },
    async start({ manifest, jobDir, onStatus = () => {} }) {
      const id = manifest.attempt_id
      mkdirSync(join(jobDir, TMP_DIR), { recursive: true, mode: 0o700 })
      const argv = nativeCommand(manifest, { jobDir, python: python.exe, platform })
      const env = nativeEnv(manifest, { jobDir, pythonDir: python.dir, platform, hostEnv })
      const L = manifest.limits
      let child, killed = null, meta = () => null, cpu = async () => null, stopWatch = () => {}
      const kill = (why) => { if (!killed) killed = why; try { if (platform === 'win32' || !child.pid) child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch {} }

      if (sandbox === 'appcontainer') {
        const name = `versum-job-${id.replace(/-/g, '')}`
        const metaFile = join(stateDir, `sandbox-${id}.json`)
        mkdirSync(stateDir, { recursive: true, mode: 0o700 })
        try { appendFileSync(profilesList, name + '\n') } catch {}
        const args = ['run', '--name', name, '--dir', jobDir, '--memory-mb', String(L.ram_mb), '--cpu-cores', String(L.cpu_cores), '--timeout-s', String(L.time_limit_minutes * 60 + 5), '--meta', metaFile, '--', ...argv]
        log(`attempt ${id}: ${SANDBOX_EXE} ${args.slice(0, 12).join(' ')} … ${argv.slice(1).join(' ')}`)
        child = spawn(helper, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const readMeta = () => { try { return JSON.parse(readFileSync(metaFile, 'utf8')) } catch { return null } }
        meta = readMeta
        cpu = async () => { const m = readMeta(); return m && Number.isFinite(m.cpu_seconds) ? m.cpu_seconds : null }
        child.on('close', () => { try { rmSync(metaFile, { force: true }) } catch {} })
        child.acName = name
      } else if (sandbox === 'seatbelt') {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 })
        const profileFile = join(stateDir, `sandbox-${id}.sb`)
        writeFileSync(profileFile, sandboxProfile({ jobDir, pythonDir: python.dir, homeDir: hostEnv.HOME ?? null }), { mode: 0o600 })
        const cpuSecs = Math.max(60, L.time_limit_minutes * 60 * Math.max(1, L.cpu_cores) + 30)
        const blocks = Math.max(2048, (L.disk_mb || 1024) * 2048)   // ulimit -f counts 512-byte blocks
        const sh = 'ulimit -t "$1" -f "$2" 2>/dev/null; shift 2; p="$1"; shift; exec /usr/bin/nice -n 10 /usr/bin/sandbox-exec -f "$p" "$@"'
        const args = ['-c', sh, 'versum-sandbox', String(cpuSecs), String(blocks), profileFile, ...argv]
        log(`attempt ${id}: sandbox-exec -f ${profileFile} ${argv.join(' ')}`)
        child = spawn('/bin/sh', args, { env, cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true })   // cwd inside the sandbox so getcwd() resolves (the /job workdir convention)
        child.profileFile = profileFile
        let last = { rssMb: 0, cpuSeconds: 0, processes: 0 }
        const limitMb = L.ram_mb
        let timer = null
        const sample = async () => {
          try { const { stdout } = await ps('/bin/ps', ['-axo', 'pgid=,rss=,cputime='], { timeout: 5000, encoding: 'utf8', maxBuffer: 8 << 20 }); const s = parsePs(stdout, child.pid); if (s.processes) last = s } catch {}
          if (last.rssMb > limitMb && !killed) { log(`attempt ${id}: memory ${Math.round(last.rssMb)} MB over the ${limitMb} MB limit — killing`); kill('memory limit') }
        }
        timer = setInterval(sample, 1000)
        stopWatch = () => clearInterval(timer)
        meta = () => ({ cpu_seconds: last.cpuSeconds, rss_mb: last.rssMb, processes: last.processes })
        cpu = async () => last.cpuSeconds
        child.on('close', () => { stopWatch(); try { rmSync(profileFile, { force: true }) } catch {} })
      } else if (sandbox === 'none') {
        log(`attempt ${id}: NO SANDBOX (test executor) ${argv.join(' ')}`)
        child = spawn(argv[0], argv.slice(1), { env, cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' })
      } else throw new Error(`unknown sandbox ${sandbox}`)

      // the disk watch: both sandboxes lack a quota, so the attempt's directory is measured every five seconds
      const diskCap = L.disk_mb ? L.disk_mb * 1048576 : null
      const diskTimer = diskCap ? setInterval(() => { const b = dirSizeBytes(jobDir); if (b > diskCap && !killed) { log(`attempt ${id}: ${Math.round(b / 1048576)} MB in the job directory, over the ${L.disk_mb} MB limit — killing`); kill('disk limit') } }, 5000) : null
      child.on('close', () => { if (diskTimer) clearInterval(diskTimer); onStatus({ note: 'exited' }) })
      return { child, kill, cpuSeconds: cpu, meta, get killedWhy() { return killed } }
    },
    async cleanup({ run }) {
      if (!run) return
      if (sandbox === 'appcontainer' && run.child?.acName) {
        try { await ps(helper, ['delete', '--name', run.child.acName], { timeout: 20_000, windowsHide: true }) } catch (e) { log(`sandbox: could not delete ${run.child.acName}: ${String(e.message).split('\n')[0]}`) }
        try { const names = readFileSync(profilesList, 'utf8').split('\n').filter((n) => n && n !== run.child.acName); writeFileSync(profilesList, names.join('\n') + (names.length ? '\n' : '')) } catch {}
      }
      if (run.child?.profileFile) try { rmSync(run.child.profileFile, { force: true }) } catch {}
    },
    async egressLog() { return null },
    /**
     * Before the first job (and after an update): the Python tree must be readable + executable by AppContainer
     * processes (ALL APPLICATION PACKAGES). The "done" marker lives in the node's per-install STATE dir keyed by
     * the Python path+mtime — NEVER inside the Python tree, or it would be packaged into the installer and a fresh
     * install would skip the grant (the ACL does not travel with the copied files) and every job would fail
     * 0xC0000135 (a DLL the sandboxed python could not read).
     */
    async ensureGrants() {
      if (sandbox !== 'appcontainer') return
      mkdirSync(stateDir, { recursive: true })
      let stamp = python.dir
      try { stamp += ':' + statSync(join(python.dir, 'python.exe')).mtimeMs } catch {}
      const marker = join(stateDir, 'appcontainer-grants.txt')
      try { if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === stamp) return } catch {}
      log('sandbox: granting AppContainer processes read+execute on the Python tree (once per install)')
      await ps(helper, ['grant-read', '--dir', python.dir], { timeout: 600_000, windowsHide: true })
      writeFileSync(marker, stamp + '\n')
    },
  }
}
