/**
 * 0.4.4 — the GPU package set on a native Windows node: torch (CUDA build), cupy-cuda12x, numba.
 *
 * Same model as lib/pylib.mjs, a second folder: when the owner ticks "share the GPU", the node downloads the wheel
 * set pinned in pylib-gpu-lock.json for this machine's CUDA (cu128 for every driver that reports CUDA >= 12.8, which
 * is what Blackwell needs) into <state>/pylib-gpu, verifies every file's sha256 against the lock, unpacks each wheel
 * with the embedded interpreter's zipfile module, imports torch with BOTH folders on sys.path and requires
 * torch.cuda.is_available() to be True on the owner's token — only then is the set `ok`. The base set is never
 * blocked: this runs after it, and a failure here leaves CPU jobs exactly as they were.
 *
 *   progress  { status: idle | pending | ok | failed | unsupported, done, total, bytes_total, bytes_done, error, dir, set }
 *   heartbeat gpu_packages: pending | ok | failed  (idle = the box is not ticked: the field is omitted)
 *   page      describeGpuPylib(progress) → "preparing GPU packages, 2.8 GB (1.1 GB done, 1 of 14)"
 *
 * The torch wheel is ~2.7 GB, so unlike the base set a download RESUMES: a partial file is continued with a Range
 * request, and a stall (no byte for 120 s) aborts the attempt instead of a fixed timeout. The sandbox side
 * (what the AppContainer must read) is ensureGpuGrants(): our own folder through the helper's grant-read, and a
 * CHECK on the driver's folders — they belong to TrustedInstaller and already carry ALL APPLICATION PACKAGES read
 * on a stock Windows (UWP games load the very same user-mode driver), so nothing is changed there, only verified.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nvidiaDriverDirs, parseIcacls } from './gpu-detect.mjs'

const execFileP = promisify(execFile)
export const PYLIB_GPU_DIR = 'pylib-gpu'
export const MARKER = '.versum-pylib-gpu.json'
const HOSTS = /^https:\/\/(files\.pythonhosted\.org|download(-r2)?\.pytorch\.org)\//
export const STALL_MS = 120_000

/** Pure: the lock's set key for this GPU (cu128 for an NVIDIA driver reporting CUDA >= 12.8), or { key: null, why }. */
export function gpuSetFor(lock, gpu, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32' || arch !== 'x64') return { key: null, why: `no GPU package set for ${platform}/${arch} (Windows x64 only in 0.4.4)` }
  if (!gpu || !gpu.model) return { key: null, why: 'no GPU on this machine' }
  if (gpu.vendor !== 'nvidia') return { key: null, why: `${gpu.model} is not an NVIDIA GPU; the GPU set is CUDA only` }
  if (!gpu.cuda) return { key: null, why: `${gpu.model}: the driver names no CUDA version — update the NVIDIA driver` }
  const [maj, min] = String(gpu.cuda).split('.').map(Number)
  const sets = Object.entries(lock?.sets ?? {})
  if (!sets.length) return { key: null, why: 'pylib-gpu-lock.json has no sets' }
  // the newest set whose minimum the driver meets: same major, driver >= min_driver_cuda (a newer major also runs older runtimes)
  const fits = sets.filter(([, s]) => { const [smaj, smin] = String(s.min_driver_cuda).split('.').map(Number); return maj > smaj || (maj === smaj && min >= smin) })
  if (!fits.length) return { key: null, why: `driver CUDA ${gpu.cuda} is older than the ${sets.map(([, s]) => s.min_driver_cuda).join('/')} the GPU set needs — update the NVIDIA driver` }
  fits.sort((a, b) => String(b[1].min_driver_cuda).localeCompare(String(a[1].min_driver_cuda), undefined, { numeric: true }))
  return { key: fits[0][0], why: null }
}

/** Pure: the wheels for a set on this platform, in lock order; throws on a malformed lock. */
export function gpuPlanFor(lock, key, platform = process.platform, arch = process.arch) {
  const pk = platform === 'win32' && arch === 'x64' ? 'win32-x64' : null
  if (!pk || !key) return { key: null, wheels: [] }
  const rows = lock?.platforms?.[pk]?.[key]
  if (!Array.isArray(rows) || !rows.length) throw new Error(`pylib-gpu-lock.json has no ${key} wheels for ${pk}`)
  for (const r of rows) if (!/^[A-Za-z0-9_.+-]+\.whl$/.test(String(r.file ?? '')) || !HOSTS.test(String(r.url ?? '')) || !/^[0-9a-f]{64}$/.test(String(r.sha256 ?? ''))) throw new Error(`pylib-gpu-lock.json: malformed entry ${JSON.stringify(r).slice(0, 120)}`)
  return { key, wheels: rows, bytes_total: rows.reduce((a, w) => a + (Number(w.size) || 0), 0) }
}

/** Pure: the stamp a finished install carries — lock version + set + every sha, so a new lock re-installs. */
export function gpuStampOf(lock, plan) {
  return createHash('sha256').update(String(lock.lock_version ?? 0) + '\n' + plan.key + '\n' + plan.wheels.map((w) => w.sha256).join('\n')).digest('hex')
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const gb = (b) => `${(b / 1073741824).toFixed(1)} GB`

/** Pure: what the page and the heartbeat say. */
export function describeGpuPylib(p) {
  if (!p || p.status === 'idle') return null
  if (p.status === 'ok') return `GPU packages ready (${p.total} wheels${p.checked ? `: ${p.checked}` : ''})`
  if (p.status === 'failed') return `GPU packages failed: ${p.error}`
  if (p.status === 'unsupported') return `no GPU packages: ${p.error}`
  const total = p.bytes_total ? `, ${gb(p.bytes_total)}` : ''
  const done = p.bytes_done ? `${gb(p.bytes_done)} done, ` : ''
  return `preparing GPU packages${total} (${done}${p.done} of ${p.total})`
}

/** Pure: the heartbeat word, or null when the box is not ticked. */
export function gpuPackagesWord(p) {
  if (!p || p.status === 'idle') return null
  if (p.status === 'ok') return 'ok'
  if (p.status === 'failed' || p.status === 'unsupported') return 'failed'
  return 'pending'
}

/**
 * Pure: the interpreter's environment additions for a GPU job. Both folders on PYTHONPATH (GPU first); torch\lib on
 * PATH and as CUDA_PATH so cupy's cuda-pathfinder and ctypes find the CUDA runtime DLLs torch bundles — the node ships
 * no CUDA toolkit of its own. `base` is the env nativeEnv() built.
 */
export function gpuJobEnv(base, { gpuDir, pylibDir, platform = process.platform }) {
  if (!gpuDir) return base
  const sep = platform === 'win32' ? ';' : ':'
  const torchLib = platform === 'win32' ? `${gpuDir}\\torch\\lib` : `${gpuDir}/torch/lib`
  return { ...base, PYTHONPATH: [gpuDir, pylibDir].filter(Boolean).join(sep), PATH: [base.PATH, torchLib].filter(Boolean).join(sep), CUDA_PATH: torchLib }
}

/** One file, resumed when a partial exists; `progress.bytes_done` grows as bytes land; a stall aborts. */
async function download(url, file, expectedSha, { fetchFn, progress, log }) {
  let have = 0
  try { have = statSync(file).size } catch {}
  const headers = have ? { range: `bytes=${have}-` } : {}
  const ctl = new AbortController()
  let timer = null
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error(`no data for ${STALL_MS / 1000} s`)), STALL_MS) }
  bump()
  const r = await fetchFn(url, { headers, signal: ctl.signal, redirect: 'follow' })
  if (r.status === 416) { clearTimeout(timer); return }   // the partial already is the whole file; the sha check decides
  if (!r.ok || !r.body) { clearTimeout(timer); throw new Error(`HTTP ${r.status}`) }
  const resumed = r.status === 206 && have > 0
  if (!resumed && have) { rmSync(file, { force: true }); progress.bytes_done -= have; have = 0 }
  if (resumed) log(`gpu packages: resuming ${file.split(/[\\/]/).pop()} at ${gb(have)}`)
  const out = createWriteStream(file, { flags: resumed ? 'a' : 'w' })
  try {
    for await (const chunk of r.body) { bump(); progress.bytes_done += chunk.length; if (!out.write(chunk)) await new Promise((res) => out.once('drain', res)) }
  } finally { clearTimeout(timer); await new Promise((res) => out.end(res)) }
}

/**
 * Download + verify + unpack once; later starts find the marker and return at once. `progress` is mutated as it goes;
 * `fetchFn` and `exec` are injectable for the tests. `pylibDir` is the READY base folder (numpy lives there).
 */
export async function ensureGpuPackages({ lock, stateDir, pythonExe, gpu, pylibDir, platform = process.platform, arch = process.arch, log = () => {}, fetchFn = globalThis.fetch, exec = execFileP, progress = {} }) {
  const dir = join(stateDir, PYLIB_GPU_DIR)
  Object.assign(progress, { status: 'pending', done: 0, total: 0, bytes_total: 0, bytes_done: 0, error: null, dir, set: null, checked: null })
  const { key, why } = gpuSetFor(lock, gpu, platform, arch)
  if (!key) { Object.assign(progress, { status: 'unsupported', error: why }); log(`gpu packages: unavailable — ${why}`); return progress }
  let plan
  try { plan = gpuPlanFor(lock, key, platform, arch) } catch (e) { Object.assign(progress, { status: 'failed', error: e.message }); log(`gpu packages: FAILED — ${e.message}`); return progress }
  progress.set = key; progress.total = plan.wheels.length; progress.bytes_total = plan.bytes_total
  const stamp = gpuStampOf(lock, plan)
  const marker = join(dir, MARKER)
  try { const m = JSON.parse(readFileSync(marker, 'utf8')); if (m.stamp === stamp) { Object.assign(progress, { status: 'ok', done: plan.wheels.length, bytes_done: plan.bytes_total, checked: m.checked ?? null }); return progress } } catch {}
  const dl = join(stateDir, 'pylib-gpu-dl')
  try {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); mkdirSync(dl, { recursive: true })
    log(`gpu packages: ${key} — ${plan.wheels.length} wheels, ${gb(plan.bytes_total)} → ${dir}`)
    // everything already downloaded and intact counts as done before the first byte of this run
    for (const w of plan.wheels) { const f = join(dl, w.file); if (existsSync(f)) { try { if (statSync(f).size <= (w.size || Infinity)) progress.bytes_done += statSync(f).size } catch {} } }
    for (const w of plan.wheels) {
      const file = join(dl, w.file)
      let ok = existsSync(file) && (!w.size || statSync(file).size === w.size) && sha256File(file) === w.sha256
      for (let attempt = 1; !ok && attempt <= 3; attempt++) {
        log(`gpu packages: fetching ${w.file} (${gb(w.size || 0)})${attempt > 1 ? `, attempt ${attempt}` : ''}`)
        try { await download(w.url, file, w.sha256, { fetchFn, progress, log }) } catch (e) { if (attempt === 3) throw new Error(`${w.file}: ${String(e.message).split('\n')[0]}`); log(`gpu packages: ${w.file}: ${String(e.message).split('\n')[0]} — retrying`); continue }
        const got = existsSync(file) ? sha256File(file) : null
        if (got === w.sha256) ok = true
        else { try { progress.bytes_done -= statSync(file).size } catch {}; rmSync(file, { force: true }); if (attempt === 3) throw new Error(`${w.file}: sha256 ${String(got).slice(0, 12)}… does not match the lock ${w.sha256.slice(0, 12)}…`) }
      }
      log(`gpu packages: unpacking ${w.file}`)
      await exec(pythonExe, ['-I', '-c', 'import sys, zipfile\nzipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', file, dir], { timeout: 1_800_000, windowsHide: true, maxBuffer: 1 << 20 })
      progress.done += 1
      log(`gpu packages: ${progress.done}/${progress.total} ${w.name} ${w.version}`)
    }
    log('gpu packages: importing torch and asking for the device')
    const check = 'import sys; sys.path[:0] = [a for a in sys.argv[1:3] if a]; import torch; ok = torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0) if ok else "NO-DEVICE")\nsys.exit(0 if ok else 7)'
    let stdout
    try { ({ stdout } = await exec(pythonExe, ['-I', '-s', '-c', check, dir, pylibDir ?? ''], { timeout: 300_000, windowsHide: true, maxBuffer: 1 << 20, env: gpuJobEnv({ PATH: join(pythonExe, '..'), SYSTEMROOT: process.env.SystemRoot ?? 'C:\\Windows' }, { gpuDir: dir, pylibDir, platform }) })) }
    catch (e) { throw new Error(e.code === 7 ? `torch imported but torch.cuda.is_available() is False on this machine (${String(e.stdout ?? '').trim()}) — driver too old for ${key}?` : `torch import failed: ${String(e.stderr ?? e.message).trim().split('\n').pop().slice(0, 300)}`) }
    const checked = String(stdout).trim()
    writeFileSync(marker, JSON.stringify({ stamp, set: key, wheels: plan.wheels.map((w) => w.file), checked, at: new Date().toISOString() }, null, 1))
    rmSync(dl, { recursive: true, force: true })
    Object.assign(progress, { status: 'ok', checked })
    log(`gpu packages: ready (${checked})`)
  } catch (e) {
    Object.assign(progress, { status: 'failed', error: String(e.message).split('\n')[0].slice(0, 300) })
    log(`gpu packages: FAILED — ${progress.error}`)
  }
  return progress
}

/**
 * The sandbox side (Windows AppContainer only). Our folder: grant-read through versum-sandbox.exe, once per stamp.
 * The driver's folders: CHECK with icacls that ALL APPLICATION PACKAGES may read them (System32 and the DriverStore
 * package); a missing grant is reported, not fixed — changing those ACLs needs an administrator and a stock Windows
 * already has them. Returns { granted, driver_dirs: [{ dir, app_packages_read }] } for the log, the page and the probe.
 */
export async function ensureGpuGrants({ helper, gpuDir, stamp, stateDir, sandbox = 'appcontainer', exec = execFileP, env = process.env, log = () => {}, driverDirs = nvidiaDriverDirs }) {
  const out = { granted: false, driver_dirs: [] }
  if (sandbox !== 'appcontainer' || !gpuDir) return out
  const marker = join(stateDir, 'appcontainer-pylib-gpu-grant.txt')
  stamp = `${stamp}:rx2`   // 0.4.6: grant-read now also grants RESTRICTED (the restricted-token mode)
  let done = false
  try { done = existsSync(marker) && readFileSync(marker, 'utf8').trim() === stamp } catch {}
  if (!done) {
    log('sandbox: granting AppContainer processes read on the GPU packages (once per lock)')
    await exec(helper, ['grant-read', '--dir', gpuDir], { timeout: 1_800_000, windowsHide: true })
    writeFileSync(marker, stamp + '\n')
  }
  out.granted = true
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  for (const dir of [win32.join(root, 'System32', 'nvcuda.dll'), ...driverDirs({ systemRoot: root })]) {
    try { const { stdout } = await exec('icacls', [dir], { timeout: 30_000, windowsHide: true, encoding: 'utf8' }); const v = parseIcacls(stdout); out.driver_dirs.push({ dir, app_packages_read: v.app_packages_read }); if (!v.app_packages_read) log(`sandbox: ${dir} is NOT readable by ALL APPLICATION PACKAGES — CUDA inside the AppContainer will fail to load the driver`) }
    catch (e) { out.driver_dirs.push({ dir, app_packages_read: null, error: String(e.message).split('\n')[0] }) }
  }
  return out
}
