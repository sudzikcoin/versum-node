/**
 * The daemon: one loop on the heartbeat cadence.
 *   always         the local page on 127.0.0.1:3311 (local-ui.mjs) — pairing, the offer, pause, earnings, the log
 *   unpaired       wait: the page (or the installer's VERSUM_NODE_KEY) hands the key over; nothing else runs
 *   every beat     heartbeat to the hub with status and (every 10th beat, or when free disk moved) the scan
 *   when free      inside a window, below max_parallel_jobs, not paused, not draining → ask for a lease; a
 *                  manifest is validated, checked against the share, then run in the background
 *   on SIGTERM     stop leasing, let running attempts finish (the time limit bounds the wait), exit
 *   0.4.3          every heartbeat answer names the newest release; a newer one is downloaded and verified in the
 *                  background, no new lease is taken, and once nothing runs the binary is swapped and the node
 *                  restarts itself (lib/update.mjs) — the key, config, name, price and pylib stay
 *   0.4.4          GPU on a native Windows node: the scan names the NVIDIA GPU and its driver's CUDA version; on
 *                  first start a probe runs inside the sandbox and the heartbeat says gpu_probe appcontainer_ok |
 *                  blocked | no_gpu; "share the GPU" fetches the cu128 package set (torch, cupy, numba —
 *                  lib/pylib-gpu.mjs), the probe runs again with torch, and only then GPU jobs are leased
 * Nothing listens except the local page on loopback. Stage 2 (2026-10-25): no CLI is needed after install —
 * every change the owner makes on the page lands in the config file and goes to the hub from here.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectRuntime, reapContainers, makeExecutor, describeRuntime } from './runtime.mjs'
import { fitsNative } from './native.mjs'
import { scan, diskFreeMb } from './scan.mjs'
import { createHub, ApiError } from './hub.mjs'
import { validateManifest, fitsShare, ManifestError } from './manifest.mjs'
import { runAttempt } from './runner.mjs'
import { createAdmission } from './admission.mjs'
import { startLocalUi, clampShare, parsePrice, marketHint, windowsToText, suggestName } from './local-ui.mjs'
import { jobsDir, ensureHome, saveConfig, bootstrapFromEnv, parseWindowsText, applyDefaultShare, HEALTH_PORT, DEFAULT_HUB } from './config.mjs'
import { recentLog } from './log.mjs'
import { NODE_VERSION } from './scan.mjs'
import { ensurePythonPackages, planFor, stampOf, describePylib } from './pylib.mjs'
import { stateDir as stateDirOf } from './config.mjs'
import { createUpdater } from './update.mjs'
import { platformKey } from './pylib.mjs'
import { NO_GPU, gpuPageLines } from './gpu-detect.mjs'
import { ensureGpuPackages, ensureGpuGrants, gpuSetFor, gpuPlanFor, gpuStampOf, describeGpuPylib, gpuPackagesWord } from './pylib-gpu.mjs'
import { runGpuProbe, describeGpuProbe } from './gpu-probe.mjs'
/** 0.4.2: the wheel lock shipped beside the app (pylib-lock.json: the standard image's packages, hashed per platform); missing → packages fail, nothing else does */
function readPylibLock(appRoot, name = 'pylib-lock.json') {
  for (const f of [join(appRoot, name), join(dirname(fileURLToPath(import.meta.url)), '..', name)]) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch {} }
  return { lock_version: 0, platforms: {} }
}

/** Where the program lives: the repository root from source, the directory of the executable as a single binary (SEA). */
const isSea = (() => { try { return process.getBuiltinModule?.('node:sea')?.isSea?.() === true } catch { return false } })()
export const APP_ROOT = process.env.VERSUM_APP_ROOT || (isSea ? dirname(process.execPath) : fileURLToPath(new URL('..', import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Pure: local weekday and minute of an instant in a zone. */
export function localClock(at, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at)
  const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), minute: (Number(get('hour')) % 24) * 60 + Number(get('minute')) }
}
/** Pure: the hub's node_window_open() rule — no windows → open; else one window contains the local time. */
export function windowOpen(windows, timezone, at = new Date()) {
  if (!windows?.length) return true
  return windows.some((w) => { const { weekday, minute } = localClock(at, w.timezone ?? timezone ?? 'UTC'); return (w.weekday == null || w.weekday === weekday) && minute >= w.start && minute < w.end })
}

/** The offer as the hub wants it on PUT /me/node, from the config. Paused → enabled false, the offer kept. */
export function offerFromConfig(cfg, resources = null) {
  return {
    ...(resources ? { resources } : {}),
    share: { cpu_cores: cfg.share.cpu_cores, ram_mb: cfg.share.ram_mb, disk_mb: cfg.share.disk_mb, gpu: cfg.share.gpu, max_parallel_jobs: cfg.share.max_parallel_jobs, max_job_minutes: cfg.share.max_job_minutes, allow_network: cfg.share.allow_network },
    price_per_minute_usd: cfg.price_per_minute_usd,
    gpu_price_per_minute_usd: cfg.gpu_price_per_minute_usd ?? null,   // 0.4.4: null = the hub's default, 5 × the CPU price
    mobility: cfg.mobility,
    windows: cfg.windows.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end, ...(w.timezone ? { timezone: w.timezone } : {}) })),
    timezone: cfg.timezone,
    enabled: cfg.price_per_minute_usd != null && !cfg.paused,
    // 10-25 — the name the owner typed on the local page travels with the offer; the hostname default stays local
    ...(cfg.name_set && cfg.name ? { name: String(cfg.name).slice(0, 80) } : {}),
  }
}

export async function startNode({ home, cfg: cfg0, log, once = false, env = process.env }) {
  ensureHome(home)
  const boot = bootstrapFromEnv(cfg0, env)
  let cfg = boot.cfg
  if (boot.applied) { saveConfig(cfg, home); log(`paired from the installer's environment (hub ${cfg.hub})`) }

  const state = {
    startedAt: new Date().toISOString(), lastBeatAt: null, lastBeatOk: null, lastError: null,
    running: new Map(), finished: [], draining: false, leases: 0, refused: 0, scan: null, rtd: null, exec: null, hub: null,
    offer: null, me: null, earnings: null, reputation: null, unpaired: false, marketAt: 0, market: null, offerAt: 0,
    // 0.4.4: the GPU set's progress (idle until the box is ticked; `ready` once the torch-stage probe passed) and the sandbox probe
    gpuPylib: { status: 'idle', ready: false }, gpuProbe: null, gpuJob: null,
  }
  const gpuOf = () => state.scan?.gpu ?? NO_GPU
  let hub = cfg.key ? createHub({ baseUrl: cfg.hub, key: cfg.key, log, userAgent: `versum-node/${NODE_VERSION}` }) : null
  const admission = createAdmission({ limit: cfg.share.max_parallel_jobs })
  // 0.4.3: the self-updater — first thing, because a process that is the result of a swap must count its start (and may roll back and exit here)
  let ui = null
  const updater = createUpdater({ appRoot: APP_ROOT, stateDir: stateDirOf(home), current: NODE_VERSION, log, isSea: isSea || env.VERSUM_NODE_UPDATER === 'force', beforeExit: async () => { try { ui?.closeAllConnections?.() } catch {} await new Promise((r) => (ui ? ui.close(() => r()) : r())) } })
  await updater.finish()

  const refreshRuntime = async () => {
    state.rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true, appRoot: APP_ROOT }).catch((e) => ({ ok: false, kind: null, name: null, reasons: [e.message], rt: null }))
    state.exec = null
    if (state.rtd.ok) {
      if (state.rtd.kind === 'native' && !state.pylib) state.pylib = { status: 'pending', done: 0, total: 0, bytes_total: 0, bytes_done: 0, error: null, dir: null }
      state.exec = makeExecutor(state.rtd, { home, egressDir: join(APP_ROOT, 'egress'), log, pylib: state.pylib ?? null, gpu: state.gpuPylib })
      if (state.rtd.kind === 'container') await reapContainers(state.rtd.rt, log).catch(() => 0)
      else {
        await state.exec.ensureGrants().catch((e) => log(`sandbox: grants failed: ${e.message}`))
        if (!state.scan) await rescan().catch(() => null)
        // 0.4.4: the sandbox probe, driver stage — as soon as the Python tree is granted; no GPU → answered without running anything
        void gpuProbe('driver')
        // 0.4.2: the standard image's packages, downloaded once per install; python jobs are not offered until this says ok
        const PYLIB_LOCK = readPylibLock(APP_ROOT)
        void ensurePythonPackages({ lock: PYLIB_LOCK, stateDir: stateDirOf(home), pythonExe: state.rtd.python?.exe ?? state.exec.python?.exe, log, progress: state.pylib })
          .then(async (p) => { if (p.status === 'ok') { await state.exec.grantPylib(p.dir, stampOf(PYLIB_LOCK, planFor(PYLIB_LOCK))).catch((e) => log(`sandbox: pylib grant failed: ${e.message}`)); void ensureGpu() } })
          .catch((e) => log(`python packages: ${e.message}`))
      }
    }
    return state.rtd
  }
  const rescan = async () => { state.scan = await scan({ jobsDir: jobsDir(home), runtime: state.rtd?.name ? state.rtd : null }); return state.scan }
  const nativeWindows = () => state.rtd?.ok && state.rtd.kind === 'native' && state.rtd.sandbox === 'appcontainer'
  /**
   * 0.4.4: the GPU probe inside the sandbox. 'driver' needs nothing but the driver; 'torch' needs the GPU set. The
   * verdict goes out on the next heartbeat (gpu_probe) and, for the torch stage, decides whether GPU jobs are taken.
   */
  const gpuProbe = async (stage) => {
    if (!state.rtd?.ok || state.rtd.kind !== 'native') return null
    if (state.rtd.sandbox !== 'appcontainer') { state.gpuProbe = { verdict: 'no_gpu', detail: 'no NVIDIA driver exists for macOS', stage: 'none', at: new Date().toISOString() }; return state.gpuProbe }
    const gpu = gpuOf()
    const progress = { status: 'running', stage }
    const prev = state.gpuProbe
    state.gpuProbe = { ...(prev ?? {}), ...progress }
    try {
      const g = state.gpuPylib
      // 0.4.6: the restricted-token fallback is OFF unless the owner opts in (config gpu_jobobject_fallback: true) — on the
      // release runner the restricted-token process dies at start with 0xC0000142 (STATUS_DLL_INIT_FAILED), so the verdict
      // stays `blocked` where the AppContainer blocks CUDA and the box on the local page says so (docs/gpu-native.md 3b)
      const fallbackExec = nativeWindows() && cfg.gpu_jobobject_fallback === true ? makeExecutor(state.rtd, { home, egressDir: join(APP_ROOT, 'egress'), log, pylib: state.pylib ?? null, gpu: state.gpuPylib, mode: 'jobobject' }) : null
      const r = await runGpuProbe({ home, appRoot: APP_ROOT, stateDir: stateDirOf(home), gpu, stage, exec: state.exec, fallbackExec, pythonExe: state.rtd.python?.exe, pythonDir: state.rtd.python?.dir, pylibDir: state.pylib?.status === 'ok' ? state.pylib.dir : null, gpuDir: stage === 'torch' ? g.dir : null, stamp: stage === 'torch' ? g.stamp : null, cpuCores: Math.min(2, state.scan?.cpu_cores ?? 2), log, nodeVersion: NODE_VERSION })
      state.gpuProbe = { verdict: r.verdict, detail: r.detail, stage: r.stage, step: r.step, at: r.at, cached: r.cached === true, sandbox_exit: r.sandbox_exit ?? null }
      if (r.cached) log(`gpu probe: ${r.verdict} (${stage} stage, cached from ${r.at}) — ${r.detail}`)
      // 0.4.6: jobobject_ok → GPU jobs run in the restricted-token mode, which needs the interpreter blocked by the firewall (one UAC prompt, once)
      g.mode = r.verdict === 'jobobject_ok' ? 'jobobject' : 'appcontainer'
      if (r.verdict === 'jobobject_ok') {
        const fw = await state.exec.ensureFirewall()
        state.gpuProbe.firewall = fw.blocked === true
        if (fw.blocked !== true) log(`gpu: restricted-token mode needs the one-time firewall rule for the interpreter — ${fw.error ?? fw.why ?? 'not added yet'}; GPU jobs wait`)
      }
      if (stage === 'torch') { g.ready = r.verdict === 'appcontainer_ok' || (r.verdict === 'jobobject_ok' && state.gpuProbe.firewall === true); if (!g.ready) log(`gpu: GPU jobs are NOT taken — ${r.detail}`); else log(`gpu: ready — GPU jobs are taken${g.mode === 'jobobject' ? ' (restricted-token sandbox)' : ''}`) }
      return state.gpuProbe
    } catch (e) { state.gpuProbe = { verdict: null, detail: `probe failed: ${String(e.message).split('\n')[0]}`, stage, at: new Date().toISOString() }; log(`gpu probe: ${e.message}`); return state.gpuProbe }
  }
  /** 0.4.4: the GPU set — when the box is ticked, the base set is in and the machine has an NVIDIA GPU with CUDA; then the torch-stage probe. One run at a time. */
  const ensureGpu = () => {
    if (state.gpuJob) return state.gpuJob
    if (!nativeWindows() || !cfg.share.gpu || state.pylib?.status !== 'ok') return null
    const g = state.gpuPylib
    if (g.status === 'ok' && g.ready) return null
    if (g.status === 'failed' && g.at && Date.now() - Date.parse(g.at) < 3_600_000) return null   // one try an hour after a failure
    const GPU_LOCK = readPylibLock(APP_ROOT, 'pylib-gpu-lock.json')
    g.ready = false
    state.gpuJob = (async () => {
      const p = await ensureGpuPackages({ lock: GPU_LOCK, stateDir: stateDirOf(home), pythonExe: state.rtd.python?.exe, gpu: gpuOf(), pylibDir: state.pylib.dir, log, progress: g })
      g.at = new Date().toISOString()
      if (p.status !== 'ok') return
      const { key } = gpuSetFor(GPU_LOCK, gpuOf())
      g.stamp = key ? gpuStampOf(GPU_LOCK, gpuPlanFor(GPU_LOCK, key)) : null
      const grants = await ensureGpuGrants({ helper: state.rtd.helper, gpuDir: p.dir, stamp: g.stamp, stateDir: stateDirOf(home), sandbox: state.rtd.sandbox, log }).catch((e) => { log(`sandbox: GPU grant failed: ${e.message}`); return null })
      if (grants && !grants.granted) return
      await gpuProbe('torch')
    })().catch((e) => log(`gpu packages: ${e.message}`)).finally(() => { state.gpuJob = null })
    return state.gpuJob
  }
  /** the whole offer to the hub; the hub keeps whatever the owner set here */
  const pushOffer = async () => {
    if (!hub) return null
    state.offer = await hub.setNode(offerFromConfig(cfg, state.scan))
    state.offerAt = Date.now()
    log(`offer: ${state.offer.enabled ? 'ON' : 'off'} · $${state.offer.price_per_minute_usd ?? '—'}/min · share ${JSON.stringify(state.offer.share)} · ${state.offer.windows?.length ? state.offer.windows.length + ' window(s)' : 'always'}${cfg.paused ? ' · PAUSED' : ''}`)
    return state.offer
  }
  const readEarnings = async () => {
    if (!hub) return
    try { const o = await hub.getNode(); state.earnings = o.earnings ?? null; state.reputation = o.reputation ?? null; state.offer = state.offer ?? o } catch (e) { log(`earnings read failed: ${e.message}`) }
  }

  // ─── what the local page can see and do ───
  const ctl = {
    state: () => ({
      version: NODE_VERSION, paired: !!cfg.key, hub: cfg.hub, name: cfg.name, paused: cfg.paused === true,
      // 0.4.5: the page's "Name this computer" — the owner's name once set, else a suggestion from the hostname / CPU (never sent until saved)
      name_set: cfg.name_set === true, name_suggested: suggestName({ hostname: cfg.name, cpu_model: state.scan?.cpu_model, os: process.platform }),
      scan: state.scan, share: cfg.share, price_per_minute_usd: cfg.price_per_minute_usd, gpu_price_per_minute_usd: cfg.gpu_price_per_minute_usd ?? null, windows: cfg.windows, windows_text: windowsToText(cfg.windows), timezone: cfg.timezone, mobility: cfg.mobility,
      runtime: state.rtd ? { ok: state.rtd.ok, kind: state.rtd.kind, name: state.rtd.name, version: state.rtd.version, rootless: state.rtd.rootless, sandbox: state.rtd.sandbox ?? null, reasons: state.rtd.reasons, consent: cfg.allow_rootful === true, description: describeRuntime(state.rtd) } : { ok: false, kind: null, name: null, reasons: ['not checked yet'] },
      presence: { last_heartbeat_at: state.lastBeatAt, last_heartbeat_ok: state.lastBeatOk, last_error: state.lastError, started_at: state.startedAt },
      pylib: state.pylib ? { ...state.pylib, line: describePylib(state.pylib) } : null,
      // 0.4.4: the GPU, its package set, the sandbox probe, and what the page shows for the two boxes
      gpu: gpuOf(),
      gpu_pylib: state.rtd?.kind === 'native' ? { ...state.gpuPylib, line: describeGpuPylib(state.gpuPylib) } : null,
      gpu_probe: state.gpuProbe ? { ...state.gpuProbe, line: describeGpuProbe(state.gpuProbe) } : null,
      gpu_page: state.rtd ? gpuPageLines({ native: state.rtd.kind === 'native', gpu: gpuOf(), gpuPackages: describeGpuPylib(state.gpuPylib) }) : null,
      update: updater.state(),
      offer: state.offer && { enabled: state.offer.enabled, window_open_now: state.offer.window_open_now, price_per_minute_usd: state.offer.price_per_minute_usd },
      earnings: state.earnings, reputation: state.reputation,
      running: [...state.running.values()], finished: state.finished.slice(-10), leases: state.leases, refused: state.refused, draining: state.draining,
    }),
    log: () => recentLog(),
    async market() {
      if (state.market && Date.now() - state.marketAt < 60_000) return state.market
      try {
        const r = await fetch(`${(cfg.hub ?? DEFAULT_HUB).replace(/\/$/, '')}/api/network/capacity`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
        const j = r.ok ? await r.json() : null
        state.market = { ...marketHint(j), at: new Date().toISOString() }
      } catch (e) { state.market = { online: 0, min: null, median: null, error: e.message } }
      state.marketAt = Date.now(); return state.market
    },
    async pair({ key, hub: hubUrl, name }) {
      key = String(key ?? '').trim()
      if (!/^llk_[0-9A-Za-z]{32}$/.test(key)) { const e = new Error('that is not a node key (llk_ followed by 32 letters and digits) — get one on the site under Connect a computer'); e.status = 400; throw e }
      const url = String(hubUrl ?? cfg.hub ?? DEFAULT_HUB).trim().replace(/\/$/, '')
      if (!/^https?:\/\/[^\s/]+/.test(url)) { const e = new Error('the hub must be an http(s) URL'); e.status = 400; throw e }
      const probe = createHub({ baseUrl: url, key, log, userAgent: `versum-node/${NODE_VERSION}` })
      let me
      try { me = await probe.me() } catch (e) { const err = new Error(e instanceof ApiError && e.status === 401 ? 'the hub does not know this key — copy it again from the site, it is shown once' : `the hub at ${url} did not accept the key: ${e.message}`); err.status = e.status === 401 ? 401 : 502; throw err }
      cfg = { ...cfg, key, hub: url, ...(name ? { name: String(name).slice(0, 80), name_set: true } : {}) }
      saveConfig(cfg, home)
      // 10-25 — the typed name used to stay in this file only, and the hub kept the key's default "My computer"
      if (name) {
        try { const o = await probe.setNode({ name: cfg.name }); if (o?.display_name) me = { ...me, executor: { ...(me.executor ?? {}), display_name: o.display_name } } }
        catch (e) { log(`the hub did not take the name "${cfg.name}": ${e.message}`) }
      }
      hub = probe; state.me = me; state.unpaired = false
      log(`paired as ${me.executor?.display_name ?? me.executor?.id} on ${url} (from the local page)`)
      return { paired: true, name: me.executor?.display_name ?? null, id: me.executor?.id ?? null, hub: url }
    },
    async setOffer(body) {
      if (!cfg.key) { const e = new Error('pair first'); e.status = 409; throw e }
      const found = state.scan ?? (await rescan().catch(() => null))
      const share = clampShare(body.share ?? cfg.share, found)
      // 0.4.4: on a native node the GPU box means the CUDA package set — an NVIDIA GPU with a CUDA driver only
      if (share.gpu && state.rtd?.kind === 'native' && !(found?.gpu?.vendor === 'nvidia' && found?.gpu?.cuda)) share.gpu = false
      const priced = parsePrice(body.price_per_minute_usd)
      if (priced.error) { const e = new Error(priced.error); e.status = 400; throw e }
      const gpuPriced = body.gpu_price_per_minute_usd === undefined ? { price: cfg.gpu_price_per_minute_usd ?? null } : parsePrice(body.gpu_price_per_minute_usd)
      if (gpuPriced.error) { const e = new Error(`GPU ${gpuPriced.error}`); e.status = 400; throw e }
      let windows = cfg.windows
      if (body.windows !== undefined) {
        try { windows = Array.isArray(body.windows) ? body.windows : (String(body.windows).trim() === '' || String(body.windows).trim().toLowerCase() === 'always' ? [] : parseWindowsText(String(body.windows))) }
        catch (e) { const err = new Error(e.message); err.status = 400; throw err }
      }
      const gpuWas = cfg.share.gpu
      cfg = { ...cfg, share, price_per_minute_usd: priced.price, gpu_price_per_minute_usd: gpuPriced.price, windows,
        ...(body.timezone ? { timezone: String(body.timezone) } : {}), ...(body.mobility === 'mobile' || body.mobility === 'stationary' ? { mobility: body.mobility } : {}), ...(body.name ? { name: String(body.name).slice(0, 80), name_set: true } : {}) }
      saveConfig(cfg, home)
      admission.limit = share.max_parallel_jobs
      // 0.4.4: ticking the GPU box starts the package set (2.8 GB, once); unticking stops offering GPU jobs — the folder stays, re-ticking is instant
      if (share.gpu && !gpuWas) void ensureGpu()
      if (!share.gpu && gpuWas) { state.gpuPylib.ready = false; if (!state.gpuJob) state.gpuPylib = Object.assign(state.gpuPylib, { status: 'idle' }); log('gpu: the box is unticked — no GPU jobs; the packages stay for next time') }
      const offer = await pushOffer()
      return { saved: true, enabled: offer?.enabled ?? false, price_per_minute_usd: cfg.price_per_minute_usd, gpu_price_per_minute_usd: cfg.gpu_price_per_minute_usd ?? null, share: cfg.share, windows_text: windowsToText(cfg.windows) }
    },
    async setPaused(paused) {
      cfg = { ...cfg, paused: !!paused }; saveConfig(cfg, home)
      log(paused ? 'paused from the local page: no new leases, the offer is kept' : 'resumed from the local page')
      if (hub) await pushOffer().catch((e) => log(`offer after pause: ${e.message}`))
      return { paused: cfg.paused }
    },
    async consentRootful(yes) {
      if (!yes) { const e = new Error('consent must be explicit'); e.status = 400; throw e }
      cfg = { ...cfg, allow_rootful: true }; saveConfig(cfg, home)
      log('owner consented to a ROOTFUL Docker daemon on the local page — a container escape would be root on this machine')
      await refreshRuntime(); await rescan().catch(() => null)
      return { allow_rootful: true, runtime: state.rtd && { ok: state.rtd.ok, name: state.rtd.name, rootless: state.rtd.rootless } }
    },
    async unpair() {
      if (hub) await hub.setNode({ enabled: false }).catch(() => null)
      cfg = { ...cfg, key: null }; saveConfig(cfg, home)
      hub = null; state.unpaired = true; state.offer = null; state.earnings = null; state.reputation = null
      log('unpaired from the local page: the key is forgotten, the node waits for a new one')
      return { paired: false }
    },
  }

  ui = startLocalUi({ port: Number(env.VERSUM_NODE_HEALTH_PORT ?? HEALTH_PORT), ctl, log, intervalSeconds: cfg.heartbeat_seconds })
  await refreshRuntime()
  if (!state.rtd.ok) for (const r of state.rtd.reasons) log(`runtime: ${r}`)
  else log(`runtime: ${describeRuntime(state.rtd)}`)
  await rescan().catch((e) => log(`scan failed: ${e.message}`))
  // 0.4.6: a fresh node shares half the machine, not all of it — once, from the first scan; the owner moves the sliders from there
  if (state.scan) {
    const d = applyDefaultShare(cfg, state.scan)
    if (d.changed) { Object.assign(cfg, d.cfg); saveConfig(cfg, home); log(`share: defaults from the first scan — ${cfg.share.cpu_cores ?? 'all'} cores, ${cfg.share.ram_mb ?? 'all'} MB RAM, ${cfg.share.disk_mb ?? 'all'} MB disk, ${cfg.share.max_parallel_jobs} job at a time`) }
  }

  const stop = () => { if (!state.draining) { state.draining = true; log(`draining: no new leases; ${state.running.size} running`) } }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)

  while (!state.draining) {
    if (!cfg.key) {
      if (once) throw new Error('not paired: open http://127.0.0.1:3311/ and paste the node key, or run `versum-node pair <key>`')
      log(`not paired — open http://127.0.0.1:${env.VERSUM_NODE_HEALTH_PORT ?? HEALTH_PORT}/ and paste the node key`)
      while (!cfg.key && !state.draining) await sleep(2000)
      continue
    }
    try { await runPaired() } catch (e) { log(`hub loop stopped: ${e.message}${once ? '' : ' — retrying in 30 s'}`); if (once) throw e; await sleep(30_000) }
  }
  ui.close()
  log('stopped')

  async function runPaired() {
    hub = hub ?? createHub({ baseUrl: cfg.hub, key: cfg.key, log, userAgent: `versum-node/${NODE_VERSION}` })
    state.hub = cfg.hub
    const me = await hub.me()
    state.me = me
    log(`paired as ${me.executor?.display_name ?? me.executor?.id} on ${cfg.hub}`)
    await rescan().catch(() => null)
    await pushOffer()
    if (!state.offer?.enabled) log(cfg.paused ? 'the node is PAUSED (local page → Resume)' : 'the node is OFF (no price set): set a price on http://127.0.0.1:3311/ or run `versum-node offer --price=0.02`')
    await readEarnings()
    let beats = 0

    const beat = async () => {
      beats++
      const freeDisk = diskFreeMb(jobsDir(home))
      const fullScan = beats % 10 === 1 || (state.scan && freeDisk !== null && Math.abs((state.scan.disk_free_mb ?? 0) - freeDisk) > 1024)
      if (fullScan) await rescan().catch(() => null)
      try {
        const pkg = state.rtd?.kind === 'native' ? (state.pylib?.status === 'ok' ? 'ok' : state.pylib?.status === 'failed' || state.pylib?.status === 'unsupported' ? 'failed' : 'pending') : 'ok'   // a container runtime has the image
        // 0.4.4: the GPU set's word (omitted while the box is unticked) and the sandbox probe's verdict (native nodes only); a change sends the resources again
        const native = state.rtd?.kind === 'native'
        const gpuWord = native && cfg.share.gpu ? gpuPackagesWord(state.gpuPylib) : null
        const probe = native && state.gpuProbe?.verdict ? state.gpuProbe.verdict : null
        const sig = `${pkg}|${gpuWord}|${probe}`
        const pkgChanged = sig !== state.lastPkg; state.lastPkg = sig
        const answer = await hub.heartbeat({ status: state.draining ? 'draining' : state.running.size ? 'working' : cfg.paused ? 'paused' : 'idle', interval_seconds: cfg.heartbeat_seconds, timezone: cfg.timezone, app: `versum-node/${NODE_VERSION}`, platform: platformKey() ?? `${process.platform}-${process.arch}`, ...((fullScan || pkgChanged) && state.scan ? { resources: { ...state.scan, python_packages: pkg, ...(gpuWord ? { gpu_packages: gpuWord } : {}), ...(probe ? { gpu_probe: probe } : {}) } } : {}) })
        state.lastBeatAt = new Date().toISOString(); state.lastBeatOk = true; state.lastError = null
        // 0.4.3: the hub names the newest release in every answer; the first good heartbeat after a swap makes the swap final
        updater.settle()
        if (answer?.release) updater.offer(answer.release)
      } catch (e) { state.lastBeatOk = false; state.lastError = e.message; log(`heartbeat failed: ${e.message}`) }
      if (beats % 4 === 0) await readEarnings()
    }
    const tryLease = async () => {
      if (state.draining || cfg.paused || !admission.canStart() || cfg.price_per_minute_usd == null) return false
      if (!state.rtd?.ok) return false
      if (updater.pending()) return false   // an update is ready: let the running jobs finish, take no new one
      if (!windowOpen(cfg.windows, cfg.timezone)) return false
      let m
      // 0.4.4: a native node offers the GPU only with the set in and the torch-stage probe passed; a container node as the owner shares it
      const gpuFree = state.rtd.kind === 'native' ? !!(cfg.share.gpu && state.gpuPylib.status === 'ok' && state.gpuPylib.ready) : cfg.share.gpu
      try { m = await hub.lease({ free: { cpu_cores: cfg.share.cpu_cores ?? state.scan?.cpu_cores, ram_mb: cfg.share.ram_mb ?? state.scan?.ram_mb, disk_mb: cfg.share.disk_mb ?? state.scan?.disk_free_mb, gpu: gpuFree, network: cfg.share.allow_network } }) }
      catch (e) { if (e instanceof ApiError && e.status === 404) { log('the hub has no /jobs/lease yet — heartbeating only'); return false } log(`lease failed: ${e.message}`); return false }
      if (!m) return false
      let manifest
      try { manifest = validateManifest(m) } catch (e) { state.refused++; log(`manifest refused: ${e.message}`); if (m?.attempt_id) await hub.release(m.attempt_id, { reason_code: 'manifest_invalid', detail: String(e.message).slice(0, 300) }).catch(() => {}); return false }
      const why = fitsShare(manifest, { share: cfg.share, found: state.scan }) ?? (state.rtd.kind === 'native' ? fitsNative(manifest, { gpuReady: gpuFree }) : null)
      if (why) { state.refused++; log(`lease ${manifest.attempt_id} refused: ${why}`); await hub.release(manifest.attempt_id, { reason_code: 'capacity', detail: why }).catch(() => {}); return false }
      state.leases++
      admission.start(manifest.attempt_id, { job_id: manifest.job_id })
      state.running.set(manifest.attempt_id, { attempt_id: manifest.attempt_id, job_id: manifest.job_id, since: new Date().toISOString(), note: 'starting', price_per_minute_usd: manifest.price_per_minute_usd })
      log(`lease ${manifest.attempt_id}: job ${manifest.job_id} piece ${manifest.piece_id} · ${manifest.kind} · ${manifest.limits.cpu_cores} cores / ${manifest.limits.ram_mb} MB / ${manifest.limits.time_limit_minutes} min · $${manifest.price_per_minute_usd}/min`)
      runAttempt({ manifest, share: cfg.share, exec: state.exec, home, hub, log, stallMs: Number(env.VERSUM_NODE_STALL_MINUTES ?? 15) * 60_000, onStatus: (s) => { const r = state.running.get(manifest.attempt_id); if (r) { r.note = s.note; r.cpu_seconds = s.cpuSeconds } } })
        .then((r) => { state.finished.push({ attempt_id: manifest.attempt_id, job_id: manifest.job_id, at: new Date().toISOString(), outcome: r.outcome, wall_seconds: r.wall_seconds, cpu_seconds: r.cpu_seconds, outputs: r.outputs?.length ?? 0 }); if (state.finished.length > 50) state.finished.splice(0, state.finished.length - 50); log(`attempt ${manifest.attempt_id}: ${r.outcome} in ${r.wall_seconds}s`) })
        .catch((e) => log(`attempt ${manifest.attempt_id}: unexpected — ${e.message}`))
        .finally(() => { admission.end(manifest.attempt_id); state.running.delete(manifest.attempt_id) })
      return true
    }

    if (once) {
      await beat(); const got = await tryLease()
      if (!got) log('once: nothing to run')
      while (state.running.size) await sleep(1000)
      state.draining = true; return
    }
    while (!state.unpaired) {
      await beat()
      // swapped and restarting: apply() exits the process. Not while a job runs, and not while the Python packages are still being unpacked (the python tree is in use)
      // 0.4.4: nor while the GPU set downloads (2.8 GB; it would resume anyway, but the python tree is in use while it unpacks)
      if (!state.draining && (await updater.applyIfIdle({ running: state.running.size + (state.pylib?.status === 'pending' ? 1 : 0) + (state.gpuPylib?.status === 'pending' ? 1 : 0) }))) return
      if (!state.draining) { let n = 0; while (n < 4 && (await tryLease())) n++ }
      if (state.draining && !state.running.size) return
      await sleep(cfg.heartbeat_seconds * 1000)
    }
  }
}

export function readJsonFile(p) { return JSON.parse(readFileSync(p, 'utf8')) }
