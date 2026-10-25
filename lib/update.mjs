/**
 * 0.4.3 — the node updates itself. Nobody reinstalls by hand again.
 *
 * Every heartbeat answer from the hub carries `release`: the newest version and, for this node's OS/arch, the
 * update asset (URL, sha256, size — the hub reads them from the GitHub Release). When the version is newer:
 *   download   in the background into <state>/update/, streamed, sha256 checked against what the hub said
 *   unpack     with the system tar (Windows 10+ and macOS both ship bsdtar) into <state>/update/<version>/
 *   smoke      the new binary must start and print exactly that version before anything is touched
 *   wait       no new leases are taken while an update is ready; the swap happens when no job runs
 *   swap       Windows: every entry of the install dir (versum-node.exe, versum-sandbox.exe, python/, probe/, …)
 *              is renamed to <name>.prev and the new one moved in — a running .exe may be renamed on Windows —
 *              then launch.vbs (the Startup entry's script) is started hidden and this process exits.
 *              macOS: ~/.versum-node/app → app.prev, the new tree → app, this process exits and launchd
 *              (KeepAlive) starts the new binary at the same path.
 *   keep       the key, config, name, price and windows live in config.json; pylib, grants and jobs under the
 *              node's home — none of it is under the entries replaced. pylib is refreshed by the new node when
 *              pylib-lock.json changed (lib/pylib.mjs keys its marker on the lock).
 *   verify     the new process finds <state>/update.json: counts its starts; the version must be the one
 *              promised; after the first good heartbeat the .prev entries are removed and the update is done.
 *   roll back  three starts without reaching that point, or a wrong version → the .prev entries go back and the
 *              process exits; the service starts the previous binary. A download or smoke failure never swaps.
 *
 * Pure: compareVersions, wantsUpdate, assetUrlAllowed, describeUpdate, swapPlan. The rest touches the machine.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync, statSync, readdirSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { platformKey } from './pylib.mjs'

const execFileP = promisify(execFile)
export const UPDATE_DIR = 'update'
export const MARKER = 'update.json'
export const PREV = '.prev'
export const MAX_STARTS = 3
/** the update bundle per platform, as release.yml names it (and the hub forwards it) */
export const assetName = (key) => `versum-node-update-${key}.tar.gz`

/** Pure: "0.4.3" vs "0.4.4-rc.2" → -1 | 0 | 1. A version without a pre-release tag is newer than one with it. */
export function compareVersions(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim()); return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null } : null }
  const A = parse(a), B = parse(b)
  if (!A || !B) return A ? 1 : B ? -1 : 0
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] > B.n[i] ? 1 : -1
  if (!A.pre && !B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1 }
    else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** Pure: where an update may come from — the release page of our repo (and what GitHub redirects to); loopback for the e2e. */
export function assetUrlAllowed(url) {
  const u = String(url ?? '')
  return /^https:\/\/github\.com\/sudzikcoin\/versum-node\/releases\/download\/[^?#\s]+$/.test(u)
    || /^https:\/\/objects\.githubusercontent\.com\/[^\s]+$/.test(u)
    || /^http:\/\/127\.0\.0\.1:\d+\/[^\s]*$/.test(u)
}

/**
 * Pure: should this node move to what the hub announced? `release` = { version, asset?: { url, sha256, size? }, override? }.
 * A dev or rc build (a version with a '-') follows nothing but an override — a CI node must not hop onto the real release
 * in the middle of its test, and a release never downgrades an rc.
 */
export function wantsUpdate({ current, release, platform = process.platform, arch = process.arch }) {
  if (!release || typeof release !== 'object') return null
  const to = String(release.version ?? '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(to)) return null
  if (compareVersions(to, current) <= 0) return null
  if (/-/.test(String(current)) && release.override !== true) return null
  const key = platformKey(platform, arch)
  if (!key) return null
  const asset = release.asset && typeof release.asset === 'object' ? release.asset : release.assets?.[key]
  if (!asset || !/^[0-9a-f]{64}$/.test(String(asset.sha256 ?? '')) || !assetUrlAllowed(asset.url)) return null
  return { to, key, asset: { url: String(asset.url), sha256: String(asset.sha256), size: Number(asset.size) || null } }
}

/** Pure: one line for the local page and the log. */
export function describeUpdate(u) {
  if (!u || u.status === 'idle') return null
  const v = u.to ? `v${u.to}` : ''
  if (u.status === 'downloading') return `updating to ${v} — downloading${u.bytes_total ? ` ${Math.round((u.bytes_done || 0) / 1048576)} of ${Math.round(u.bytes_total / 1048576)} MB` : ''}`
  if (u.status === 'unpacking') return `updating to ${v} — unpacking`
  if (u.status === 'ready') return `updating to ${v} — waiting for the running job to finish`
  if (u.status === 'applying') return `updating to ${v} — restarting`
  if (u.status === 'verifying') return `updated to ${v} — checking in with the hub`
  if (u.status === 'done') return `updated to ${v}${u.from ? ` from v${u.from}` : ''}`
  if (u.status === 'failed') return `update to ${v} failed: ${u.error} — still on v${u.from ?? '?'}`
  if (u.status === 'rolled_back') return `update to ${v} was rolled back: ${u.error} — still on v${u.from ?? '?'}`
  return null
}

/**
 * Pure: which entries of the install dir are replaced on Windows, from what the bundle holds. Never the node's home
 * (config, state, jobs), never a .prev entry, never the log.
 */
export function swapPlan(bundleEntries) {
  return bundleEntries.filter((n) => n && n !== 'home' && !n.endsWith(PREV) && !/\.log$/i.test(n) && !n.startsWith('.'))
}

export function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function renameRetry(from, to, tries = 20) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return } catch (e) { if (i >= tries) throw e; await sleep(250) }
  }
}
function rmQuiet(p) { try { rmSync(p, { recursive: true, force: true }) } catch {} }
function readMarker(stateDir) { try { return JSON.parse(readFileSync(join(stateDir, MARKER), 'utf8')) } catch { return null } }
function writeMarker(stateDir, m) { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, MARKER), JSON.stringify(m, null, 1)) }
const tarBin = (platform) => (platform === 'win32' ? join(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar')
const exeName = (platform) => (platform === 'win32' ? 'versum-node.exe' : 'versum-node')

/**
 * The updater the node drives: offer() on every heartbeat with the hub's `release`, pending() while a swap waits,
 * applyIfIdle() each beat, and finish() once at start to close (or roll back) the previous swap.
 */
export function createUpdater({ appRoot, stateDir, current, platform = process.platform, arch = process.arch, log = () => {}, fetchFn = globalThis.fetch, exec = execFileP, spawnFn = spawn, beforeExit = async () => {}, exit = (code) => process.exit(code), isSea = true }) {
  const u = { status: 'idle', from: current, to: null, key: null, bytes_done: 0, bytes_total: 0, error: null, dir: null, at: null }
  let job = null
  const dir = join(stateDir, UPDATE_DIR)
  const line = () => describeUpdate(u)

  async function download(want) {
    Object.assign(u, { status: 'downloading', to: want.to, key: want.key, bytes_done: 0, bytes_total: want.asset.size ?? 0, error: null, dir: null, at: new Date().toISOString() })
    log(`update: v${want.to} is out (this is v${current}) — downloading ${basename(new URL(want.asset.url).pathname)}`)
    const file = join(dir, `${want.to}.tar.gz`), out = join(dir, want.to)
    rmQuiet(dir); mkdirSync(dir, { recursive: true })
    const r = await fetchFn(want.asset.url, { signal: AbortSignal.timeout(900_000), redirect: 'follow', headers: { 'user-agent': `versum-node/${current}` } })
    if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`)
    const hash = createHash('sha256')
    const { Transform } = await import('node:stream')
    const tap = new Transform({ transform(c, _e, cb) { u.bytes_done += c.length; hash.update(c); cb(null, c) } })
    await pipeline(Readable.fromWeb(r.body), tap, createWriteStream(file))
    const got = hash.digest('hex')
    if (got !== want.asset.sha256) throw new Error(`sha256 ${got.slice(0, 12)}… is not what the hub announced (${want.asset.sha256.slice(0, 12)}…)`)
    if (want.asset.size && statSync(file).size !== want.asset.size) throw new Error(`size ${statSync(file).size} ≠ ${want.asset.size}`)
    u.status = 'unpacking'
    mkdirSync(out, { recursive: true })
    await exec(tarBin(platform), ['-xzf', file, '-C', out], { timeout: 600_000, windowsHide: true, maxBuffer: 1 << 20 })
    const exe = join(out, exeName(platform))
    if (!existsSync(exe)) throw new Error(`the bundle has no ${exeName(platform)}`)
    // the new binary must start here and say it is the version promised, before a single file is touched
    const { stdout } = await exec(exe, ['version'], { timeout: 60_000, windowsHide: true, env: { ...process.env, VERSUM_APP_ROOT: out, VERSUM_NODE_HOME: join(out, '.smoke-home') }, maxBuffer: 1 << 20 })
    rmQuiet(join(out, '.smoke-home'))
    const said = String(stdout).trim().replace(/^versum-node\s+/, '')
    if (said !== want.to) throw new Error(`the new binary says ${JSON.stringify(said)}, not ${want.to}`)
    rmQuiet(file)
    Object.assign(u, { status: 'ready', dir: out })
    log(`update: v${want.to} downloaded, verified and started once — it goes in as soon as no job is running`)
  }

  /** Windows: entry by entry in the install dir; macOS: the whole app dir. Then the service starts the new binary. */
  async function apply() {
    u.status = 'applying'
    const marker = { from: current, to: u.to, at: new Date().toISOString(), phase: 'applying', starts: 0, platform }
    log(`update: swapping v${current} → v${u.to}`)
    if (platform === 'win32') {
      const entries = swapPlan(readdirSync(u.dir))
      marker.entries = entries
      writeMarker(stateDir, marker)
      for (const n of entries) { rmQuiet(join(appRoot, n + PREV)); if (existsSync(join(appRoot, n))) await renameRetry(join(appRoot, n), join(appRoot, n + PREV)) }
      for (const n of entries) await renameRetry(join(u.dir, n), join(appRoot, n))
      await beforeExit()
      // the Startup entry's own script: starts the node hidden when the page does not answer (it will not — we are leaving)
      const vbs = join(appRoot, 'launch.vbs')
      const child = spawnFn(join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'wscript.exe'), ['//B', vbs], { detached: true, stdio: 'ignore', windowsHide: true, cwd: appRoot })
      child.unref()
    } else {
      const parent = dirname(appRoot), prev = join(parent, basename(appRoot) + PREV), fresh = join(parent, basename(appRoot) + '.new')
      marker.app = appRoot
      writeMarker(stateDir, marker)
      rmQuiet(prev); rmQuiet(fresh)
      await renameRetry(u.dir, fresh)
      for (const keep of ['uninstall.sh']) { try { if (existsSync(join(appRoot, keep)) && !existsSync(join(fresh, keep))) copyFileSync(join(appRoot, keep), join(fresh, keep)) } catch {} }
      await renameRetry(appRoot, prev)
      await renameRetry(fresh, appRoot)
      await beforeExit()
    }
    rmQuiet(dir)
    log('update: restarting')
    exit(0)
  }

  /** Put the previous entries back (the new process found itself wrong, or never came up three times). */
  async function rollback(m, why) {
    log(`update: ROLLING BACK to v${m.from}: ${why}`)
    if (m.platform === 'win32' || (platform === 'win32' && m.entries)) {
      for (const n of m.entries ?? []) { if (existsSync(join(appRoot, n + PREV))) { rmQuiet(join(appRoot, n)); try { await renameRetry(join(appRoot, n), join(appRoot, n + '.failed')) } catch {} await renameRetry(join(appRoot, n + PREV), join(appRoot, n)) } }
      for (const n of m.entries ?? []) rmQuiet(join(appRoot, n + '.failed'))
    } else {
      const app = m.app ?? appRoot, prev = app + PREV
      if (existsSync(prev)) { rmQuiet(app + '.failed'); await renameRetry(app, app + '.failed'); await renameRetry(prev, app); rmQuiet(app + '.failed') }
    }
    writeMarker(stateDir, { ...m, phase: 'rolled_back', error: why, at: new Date().toISOString() })
  }

  return {
    state: () => ({ ...u, line: line() }),
    pending: () => u.status === 'ready' || u.status === 'applying',
    /** every heartbeat: the hub's `release` block */
    offer(release) {
      if (job || u.status === 'ready' || u.status === 'applying') return
      const want = wantsUpdate({ current, release, platform, arch })
      if (!want) return
      if (u.status === 'failed' && u.to === want.to && Date.now() - Date.parse(u.at) < 3_600_000) return   // one try an hour per version
      if (u.status === 'rolled_back' && u.to === want.to) return   // a version that came back out is not tried again on this install
      if (!isSea) { if (u.status !== 'failed') { Object.assign(u, { status: 'failed', to: want.to, error: 'this node runs from source; update it with git / the installer', at: new Date().toISOString() }); log(`update: v${want.to} is out, but ${u.error}`) } return }
      job = download(want).catch((e) => { Object.assign(u, { status: 'failed', error: String(e.message).split('\n')[0].slice(0, 300), at: new Date().toISOString() }); rmQuiet(dir); log(`update: FAILED — ${u.error} (still on v${current})`) }).finally(() => { job = null })
    },
    /** every beat: the swap, once nothing runs */
    async applyIfIdle({ running }) {
      if (u.status !== 'ready' || running > 0) return false
      try { await apply(); return true } catch (e) { Object.assign(u, { status: 'failed', error: String(e.message).split('\n')[0].slice(0, 300), at: new Date().toISOString() }); log(`update: swap FAILED — ${u.error}`); const m = readMarker(stateDir); if (m?.phase === 'applying') await rollback(m, u.error).catch((e2) => log(`update: rollback failed too: ${e2.message}`)); return false }
    },
    /**
     * At start: is this process the result of a swap? Count the start; a wrong version or too many starts → roll back
     * and exit (the service brings the previous binary back). Otherwise 'verifying' until the first good heartbeat.
     */
    async finish() {
      const m = readMarker(stateDir)
      if (!m) return null
      if (m.phase === 'applying' || m.phase === 'verifying') {
        m.starts = (m.starts ?? 0) + 1
        if (current !== m.to) { await rollback(m, `started as v${current}, expected v${m.to}`); exit(0); return m }
        if (m.starts > MAX_STARTS) { await rollback(m, `v${m.to} started ${m.starts} times without reaching the hub`); exit(0); return m }
        m.phase = 'verifying'; writeMarker(stateDir, m)
        Object.assign(u, { status: 'verifying', from: m.from, to: m.to, at: m.at })
        log(`update: now running v${current} (was v${m.from}); the .prev copies go once the hub hears from us`)
      } else if (m.phase === 'rolled_back') { Object.assign(u, { status: 'rolled_back', from: m.from, to: m.to, error: m.error, at: m.at }) }
      else if (m.phase === 'done') { Object.assign(u, { status: 'done', from: m.from, to: m.to, at: m.at }) }
      return m
    },
    /** after a good heartbeat: the swap is final */
    settle() {
      if (u.status !== 'verifying') return
      const m = readMarker(stateDir)
      if (m?.platform === 'win32' || (platform === 'win32' && m?.entries)) for (const n of m.entries ?? []) rmQuiet(join(appRoot, n + PREV))
      else rmQuiet((m?.app ?? appRoot) + PREV)
      rmQuiet(dir)
      writeMarker(stateDir, { ...(m ?? {}), phase: 'done', at: new Date().toISOString() })
      u.status = 'done'
      log(`update: done — v${u.to} is in, v${u.from} removed`)
    },
  }
}
