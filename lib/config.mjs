/**
 * One config file, mode 0600, in the node's home (VERSUM_NODE_HOME, default ~/.versum-node):
 *   hub       the hub's base URL
 *   key       the node key the owner pasted once (llk_…) — the only secret the node holds
 *   name      what this computer is called on the board
 *   runtime   "native" | "podman" | "docker" | null (auto: the built-in sandbox on Windows/macOS, Podman then Docker on Linux)
 *   share     { cpu_cores, ram_mb, disk_mb, gpu, max_parallel_jobs, max_job_minutes, allow_network }
 *   price_per_minute_usd, mobility, windows, timezone
 * The jobs directory (home/jobs) is the ONLY path a job container ever sees, one subdirectory per attempt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

export const DEFAULT_HUB = 'https://launchloop.suverse.io'
export const HEALTH_PORT = 3311

export function nodeHome() { return process.env.VERSUM_NODE_HOME || join(os.homedir(), '.versum-node') }
export function configPath(home = nodeHome()) { return join(home, 'config.json') }
export function jobsDir(home = nodeHome()) { return join(home, 'jobs') }
export function stateDir(home = nodeHome()) { return join(home, 'state') }

export const DEFAULT_CONFIG = {
  hub: DEFAULT_HUB,
  key: null,
  name: os.hostname(),
  runtime: null,
  share: { cpu_cores: null, ram_mb: null, disk_mb: null, gpu: false, max_parallel_jobs: 1, max_job_minutes: 240, allow_network: false },
  price_per_minute_usd: null,
  gpu_price_per_minute_usd: null,   // 0.4.4: the rate for a GPU job; null = the hub's default, 5 × the CPU price
  mobility: 'stationary',
  windows: [],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  heartbeat_seconds: heartbeatSecondsFromEnv(process.env),
  paused: false,          // stage 2d: the owner pressed Pause on the local page — the offer stays, enabled goes false
  allow_rootful: false,   // stage 2a: one-time consent to a ROOTFUL Docker daemon, given on the local page, never an env var
  share_defaulted: false,  // 0.4.6: the first scan filled the share with half the machine (defaultShare); never redone
  python_image: null,   // the hub names the standard image (pinned digest) in every manifest; this is only a local override for `run-local`
}

/**
 * The installer may hand the key and the hub over as environment (VERSUM_NODE_KEY, VERSUM_HUB) so the first
 * start is already paired and nobody opens a terminal. Applied once, when the config has no key; the
 * environment is never read again after that. Pure given its inputs.
 */
export function bootstrapFromEnv(cfg, env = process.env) {
  if (cfg.key) return { cfg, applied: false }
  const key = env.VERSUM_NODE_KEY
  if (!key || !/^llk_[0-9A-Za-z]{32}$/.test(key)) return { cfg, applied: false }
  const next = { ...cfg, key, hub: env.VERSUM_HUB && /^https?:\/\//.test(env.VERSUM_HUB) ? env.VERSUM_HUB.replace(/\/$/, '') : cfg.hub }
  if (env.VERSUM_NODE_NAME) next.name = String(env.VERSUM_NODE_NAME).slice(0, 80)
  return { cfg: next, applied: true }
}

/** VERSUM_NODE_HEARTBEAT_SECONDS (5–300) shortens the beat — for tests and CI; the hub still clamps what it is told to 30–60. */
export function heartbeatSecondsFromEnv(env = process.env, dflt = 30) {
  const n = Number(env.VERSUM_NODE_HEARTBEAT_SECONDS)
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.min(300, Math.floor(n))) : dflt
}

export function ensureHome(home = nodeHome()) {
  for (const d of [home, jobsDir(home), stateDir(home)]) mkdirSync(d, { recursive: true, mode: 0o700 })
  return home
}

export function loadConfig(home = nodeHome()) {
  const p = configPath(home)
  if (!existsSync(p)) return { ...DEFAULT_CONFIG, share: { ...DEFAULT_CONFIG.share }, windows: [] }
  // Windows has no POSIX mode: the profile directory is ACL-protected (and AppContainer jobs cannot read it at all)
  if (process.platform !== 'win32') {
    const mode = statSync(p).mode & 0o777
    if (mode & 0o077) throw new Error(`${p} is readable by others (mode ${mode.toString(8)}); run: chmod 600 ${p}`)
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  const cfg = { ...DEFAULT_CONFIG, ...raw, share: { ...DEFAULT_CONFIG.share, ...(raw.share ?? {}) }, windows: Array.isArray(raw.windows) ? raw.windows : [] }
  if (process.env.VERSUM_NODE_HEARTBEAT_SECONDS) cfg.heartbeat_seconds = heartbeatSecondsFromEnv(process.env, cfg.heartbeat_seconds)
  return cfg
}

export function saveConfig(cfg, home = nodeHome()) {
  ensureHome(home)
  const p = configPath(home)
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600)
  return p
}

/**
 * 0.4.6: the share a FRESH node starts with — half the cores, half the RAM, the smaller of 1 GB and half the free
 * disk, one job at a time — instead of "all of it" (nulls). Pure: from the scan. Anything the scan does not know
 * stays null (all of it) and is filled on a later scan.
 */
export function defaultShare(scan) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  const cores = n(scan?.cpu_cores), ram = n(scan?.ram_mb), disk = n(scan?.disk_free_mb)
  return {
    cpu_cores: cores === null ? null : Math.max(1, Math.floor(cores / 2)),
    ram_mb: ram === null ? null : Math.max(512, Math.floor(ram / 2)),
    disk_mb: disk === null ? null : Math.max(256, Math.min(1024, Math.floor(disk / 2))),
    max_parallel_jobs: 1,
  }
}

/**
 * 0.4.6: apply the defaults ONCE to a config whose owner never set a share (share_defaulted is not yet true): every
 * null dimension gets the default; dimensions the owner already set stay. Marks share_defaulted when every dimension
 * is known, so a later "--cpu=0" (all of it) is never overwritten. Pure: returns { cfg, changed }.
 */
export function applyDefaultShare(cfg, scan) {
  if (cfg.share_defaulted === true) return { cfg, changed: false }
  const d = defaultShare(scan)
  const share = { ...cfg.share }
  let changed = false
  for (const k of ['cpu_cores', 'ram_mb', 'disk_mb']) if ((share[k] === null || share[k] === undefined) && d[k] !== null) { share[k] = d[k]; changed = true }
  if (share.max_parallel_jobs === null || share.max_parallel_jobs === undefined) { share.max_parallel_jobs = 1; changed = true }
  const complete = ['cpu_cores', 'ram_mb', 'disk_mb'].every((k) => share[k] !== null && share[k] !== undefined)
  return { cfg: { ...cfg, share, ...(complete ? { share_defaulted: true } : {}) }, changed: changed || complete }
}

/** What the config looks like with the key hidden — for `status` and the health page. */
export function redactConfig(cfg) {
  return { ...cfg, key: cfg.key ? `${String(cfg.key).slice(0, 8)}…` : null }
}

/** Parse "k=v" pairs from the CLI into a patch of the config's share/price/windows. Pure. */
export function offerPatchFromArgs(args) {
  const patch = { share: {} }
  for (const a of args) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a)
    if (!m) throw new Error(`unknown argument ${a}`)
    const [, k, v] = m
    const int = () => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`--${k} must be a whole number`); return n === 0 ? null : n }
    const bool = () => v === 'true' || v === '1' || v === 'yes' || v === 'on'
    switch (k) {
      case 'cpu': case 'cpu-cores': patch.share.cpu_cores = int(); break
      case 'ram': case 'ram-mb': patch.share.ram_mb = int(); break
      case 'ram-gb': patch.share.ram_mb = int() === null ? null : int() * 1024; break
      case 'disk': case 'disk-mb': patch.share.disk_mb = int(); break
      case 'disk-gb': patch.share.disk_mb = int() === null ? null : int() * 1024; break
      case 'gpu': patch.share.gpu = bool(); break
      case 'parallel': case 'max-parallel-jobs': { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('--parallel must be 1–32'); patch.share.max_parallel_jobs = n; break }
      case 'max-job-minutes': patch.share.max_job_minutes = int(); break
      case 'network': case 'allow-network': patch.share.allow_network = bool(); break
      case 'price': { const n = Number(v); if (!(n >= 0 && n <= 1000)) throw new Error('--price must be USD per minute, 0–1000'); patch.price_per_minute_usd = Number(n.toFixed(6)); break }
      case 'mobility': if (v !== 'stationary' && v !== 'mobile') throw new Error('--mobility must be stationary or mobile'); patch.mobility = v; break
      case 'timezone': patch.timezone = v; break
      case 'windows': {
        // "Mon-Fri 22:00-07:00,Sat 00:00-24:00" or "always"; an overnight range becomes two windows
        patch.windows = v.trim() === 'always' || v.trim() === '' ? [] : parseWindowsText(v)
        break
      }
      case 'name': patch.name = v.slice(0, 80); break
      default: throw new Error(`unknown option --${k}`)
    }
  }
  if (!Object.keys(patch.share).length) delete patch.share
  return patch
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
/** Pure: "Mon-Fri 22:00-07:00, Sat 00:00-24:00" → windows (overnight ranges split at midnight). */
export function parseWindowsText(text) {
  const out = []
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:([a-z]{3})(?:-([a-z]{3}))?\s+)?(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/i.exec(part)
    if (!m) throw new Error(`cannot read window "${part}" (expected e.g. "Mon-Fri 22:00-07:00")`)
    const [, d1, d2, start, end] = m
    let days = [null]
    if (d1) {
      const a = DAYS.indexOf(d1.toLowerCase()), b = d2 ? DAYS.indexOf(d2.toLowerCase()) : a
      if (a < 0 || b < 0) throw new Error(`unknown day in "${part}"`)
      days = []; for (let i = a; ; i = (i + 1) % 7) { days.push(i); if (i === b) break }
    }
    const toMin = (s) => { const [h, mm] = s.split(':').map(Number); if (h > 24 || mm > 59) throw new Error(`bad time in "${part}"`); return h * 60 + mm }
    const s = toMin(start), e = toMin(end)
    for (const weekday of days) {
      if (e > s) out.push({ weekday, start: s, end: e })
      else if (e === s) throw new Error(`empty window "${part}"`)
      else { out.push({ weekday, start: s, end: 1440 }); out.push({ weekday: weekday === null ? null : (weekday + 1) % 7, start: 0, end: e }) }
    }
  }
  return out
}
