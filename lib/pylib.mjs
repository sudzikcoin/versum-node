/**
 * 0.4.2 — the standard image's Python packages on a NATIVE node (Windows AppContainer, macOS Seatbelt).
 * The embedded Python ships no packages, while every composed script expects numpy, pandas, pillow, requests,
 * pypdf, openpyxl, python-docx (images/python/Dockerfile). On first start after an install (never in the
 * installer: it stays small) the node downloads the same packages, pinned to the same versions, as wheels from
 * PyPI into <state>/pylib, verifies every file's sha256 against pylib-lock.json shipped in the release, and
 * unpacks them with the embedded interpreter's own zipfile module. Jobs get the folder on PYTHONPATH; the
 * sandbox reads it like the Python tree and still has no network. Progress is what the local page shows and
 * `python_packages: ok | pending | failed` is what the hub hears on every heartbeat.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
export const PYLIB_DIR = 'pylib'
export const MARKER = '.versum-pylib.json'

/** Pure: the lock's key for this machine, or null when the release ships no wheels for it. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  return null
}

/** Pure: the wheels this machine needs, in lock order; throws on a malformed lock. */
export function planFor(lock, platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch)
  if (!key) return { key: null, wheels: [] }
  const rows = lock?.platforms?.[key]
  if (!Array.isArray(rows) || !rows.length) throw new Error(`pylib-lock.json has no wheels for ${key}`)
  for (const r of rows) if (!/^[A-Za-z0-9_.+-]+\.whl$/.test(String(r.file ?? '')) || !/^https:\/\/files\.pythonhosted\.org\//.test(String(r.url ?? '')) || !/^[0-9a-f]{64}$/.test(String(r.sha256 ?? ''))) throw new Error(`pylib-lock.json: malformed entry ${JSON.stringify(r).slice(0, 120)}`)
  return { key, wheels: rows }
}

/** Pure: the stamp a finished install carries — the lock version + every sha, so a new lock re-installs. */
export function stampOf(lock, plan) {
  return createHash('sha256').update(String(lock.lock_version ?? 0) + '\n' + plan.wheels.map((w) => w.sha256).join('\n')).digest('hex')
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Pure: what the page and the heartbeat say. */
export function describePylib(p) {
  if (!p) return null
  if (p.status === 'ok') return `Python packages ready (${p.total} wheels)`
  if (p.status === 'failed') return `Python packages failed: ${p.error}`
  if (p.status === 'unsupported') return `no Python packages for this platform (${p.error})`
  const mb = Math.round((p.bytes_total || 0) / 1048576)
  return `preparing Python packages${mb ? `, ${mb} MB` : ''} (${p.done} of ${p.total})`
}

/**
 * Download + verify + unpack once; later starts find the marker and return at once. `progress` is mutated as
 * it goes (status pending → ok | failed, done/total, bytes); `fetch` and `exec` are injectable for the tests.
 */
export async function ensurePythonPackages({ lock, stateDir, pythonExe, platform = process.platform, arch = process.arch, log = () => {}, fetchFn = globalThis.fetch, exec = execFileP, progress = {} }) {
  const dir = join(stateDir, PYLIB_DIR)
  Object.assign(progress, { status: 'pending', done: 0, total: 0, bytes_total: 0, bytes_done: 0, error: null, dir })
  let plan
  try { plan = planFor(lock, platform, arch) } catch (e) { Object.assign(progress, { status: 'failed', error: e.message }); return progress }
  if (!plan.key) { Object.assign(progress, { status: 'unsupported', error: `${platform}/${arch}` }); return progress }
  progress.total = plan.wheels.length
  const stamp = stampOf(lock, plan)
  const marker = join(dir, MARKER)
  try { if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).stamp === stamp) { Object.assign(progress, { status: 'ok', done: plan.wheels.length }); return progress } } catch {}
  const dl = join(stateDir, 'pylib-dl')
  try {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); mkdirSync(dl, { recursive: true })
    // sizes first, so the page can say "60 MB" before the first byte lands
    for (const w of plan.wheels) { try { const h = await fetchFn(w.url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) }); progress.bytes_total += Number(h.headers.get('content-length') ?? 0) } catch {} }
    log(`python packages: ${plan.wheels.length} wheels for ${plan.key}, ${Math.round(progress.bytes_total / 1048576)} MB → ${dir}`)
    for (const w of plan.wheels) {
      const file = join(dl, w.file)
      if (!existsSync(file) || sha256File(file) !== w.sha256) {
        const r = await fetchFn(w.url, { signal: AbortSignal.timeout(600_000) })
        if (!r.ok || !r.body) throw new Error(`${w.file}: HTTP ${r.status}`)
        await pipeline(Readable.fromWeb(r.body), createWriteStream(file))
        const got = sha256File(file)
        if (got !== w.sha256) { rmSync(file, { force: true }); throw new Error(`${w.file}: sha256 ${got.slice(0, 12)}… does not match the lock ${w.sha256.slice(0, 12)}…`) }
      }
      progress.bytes_done += statSync(file).size
      // a wheel is a zip: unpacking it IS the install (no scripts, no build step); the embedded interpreter does it
      await exec(pythonExe, ['-I', '-c', 'import sys, zipfile\nzipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', file, dir], { timeout: 300_000, windowsHide: true })
      progress.done += 1
      log(`python packages: ${progress.done}/${progress.total} ${w.name} ${w.version}`)
    }
    const { stdout } = await exec(pythonExe, ['-I', '-s', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import numpy, pandas, PIL, requests, pypdf, openpyxl, docx; print(numpy.__version__, pandas.__version__)', dir], { timeout: 120_000, windowsHide: true })
    writeFileSync(marker, JSON.stringify({ stamp, key: plan.key, wheels: plan.wheels.map((w) => w.file), checked: String(stdout).trim(), at: new Date().toISOString() }, null, 1))
    rmSync(dl, { recursive: true, force: true })
    Object.assign(progress, { status: 'ok' })
    log(`python packages: ready (${String(stdout).trim()})`)
  } catch (e) {
    Object.assign(progress, { status: 'failed', error: String(e.message).split('\n')[0].slice(0, 300) })
    log(`python packages: FAILED — ${progress.error}`)
  }
  return progress
}
