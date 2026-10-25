/**
 * The daemon: one loop on the heartbeat cadence.
 *   always         the local page on 127.0.0.1:3311 (local-ui.mjs) — pairing, the offer, pause, earnings, the log
 *   unpaired       wait: the page (or the installer's VERSUM_NODE_KEY) hands the key over; nothing else runs
 *   every beat     heartbeat to the hub with status and (every 10th beat, or when free disk moved) the scan
 *   when free      inside a window, below max_parallel_jobs, not paused, not draining → ask for a lease; a
 *                  manifest is validated, checked against the share, then run in the background
 *   on SIGTERM     stop leasing, let running attempts finish (the time limit bounds the wait), exit
 * Nothing listens except the local page on loopback. Stage 2 (2026-10-25): no CLI is needed after install —
 * every change the owner makes on the page lands in the config file and goes to the hub from here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectRuntime, reapContainers } from './runtime.mjs'
import { scan } from './scan.mjs'
import { createHub, ApiError } from './hub.mjs'
import { validateManifest, fitsShare, ManifestError } from './manifest.mjs'
import { runAttempt } from './runner.mjs'
import { createAdmission } from './admission.mjs'
import { startLocalUi, clampShare, parsePrice, marketHint, windowsToText } from './local-ui.mjs'
import { jobsDir, ensureHome, saveConfig, bootstrapFromEnv, parseWindowsText, HEALTH_PORT, DEFAULT_HUB } from './config.mjs'
import { recentLog } from './log.mjs'
import { NODE_VERSION } from './scan.mjs'

export const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
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
    mobility: cfg.mobility,
    windows: cfg.windows.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end, ...(w.timezone ? { timezone: w.timezone } : {}) })),
    timezone: cfg.timezone,
    enabled: cfg.price_per_minute_usd != null && !cfg.paused,
  }
}

export async function startNode({ home, cfg: cfg0, log, once = false, env = process.env }) {
  ensureHome(home)
  const boot = bootstrapFromEnv(cfg0, env)
  let cfg = boot.cfg
  if (boot.applied) { saveConfig(cfg, home); log(`paired from the installer's environment (hub ${cfg.hub})`) }

  const state = {
    startedAt: new Date().toISOString(), lastBeatAt: null, lastBeatOk: null, lastError: null,
    running: new Map(), finished: [], draining: false, leases: 0, refused: 0, scan: null, rtd: null, hub: null,
    offer: null, me: null, earnings: null, reputation: null, unpaired: false, marketAt: 0, market: null, offerAt: 0,
  }
  let hub = cfg.key ? createHub({ baseUrl: cfg.hub, key: cfg.key, log }) : null
  const admission = createAdmission({ limit: cfg.share.max_parallel_jobs })

  const refreshRuntime = async () => {
    state.rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true }).catch((e) => ({ ok: false, name: null, reasons: [e.message], rt: null }))
    if (state.rtd.ok) await reapContainers(state.rtd.rt, log).catch(() => 0)
    return state.rtd
  }
  const rescan = async () => { state.scan = await scan({ jobsDir: jobsDir(home), runtime: state.rtd?.name ? state.rtd : null }); return state.scan }
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
      scan: state.scan, share: cfg.share, price_per_minute_usd: cfg.price_per_minute_usd, windows: cfg.windows, windows_text: windowsToText(cfg.windows), timezone: cfg.timezone, mobility: cfg.mobility,
      runtime: state.rtd ? { ok: state.rtd.ok, name: state.rtd.name, version: state.rtd.version, rootless: state.rtd.rootless, reasons: state.rtd.reasons, consent: cfg.allow_rootful === true } : { ok: false, name: null, reasons: ['not checked yet'] },
      presence: { last_heartbeat_at: state.lastBeatAt, last_heartbeat_ok: state.lastBeatOk, last_error: state.lastError, started_at: state.startedAt },
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
      const probe = createHub({ baseUrl: url, key, log })
      let me
      try { me = await probe.me() } catch (e) { const err = new Error(e instanceof ApiError && e.status === 401 ? 'the hub does not know this key — copy it again from the site, it is shown once' : `the hub at ${url} did not accept the key: ${e.message}`); err.status = e.status === 401 ? 401 : 502; throw err }
      cfg = { ...cfg, key, hub: url, ...(name ? { name: String(name).slice(0, 80) } : {}) }
      saveConfig(cfg, home)
      hub = probe; state.me = me; state.unpaired = false
      log(`paired as ${me.executor?.display_name ?? me.executor?.id} on ${url} (from the local page)`)
      return { paired: true, name: me.executor?.display_name ?? null, id: me.executor?.id ?? null, hub: url }
    },
    async setOffer(body) {
      if (!cfg.key) { const e = new Error('pair first'); e.status = 409; throw e }
      const found = state.scan ?? (await rescan().catch(() => null))
      const share = clampShare(body.share ?? cfg.share, found)
      const priced = parsePrice(body.price_per_minute_usd)
      if (priced.error) { const e = new Error(priced.error); e.status = 400; throw e }
      let windows = cfg.windows
      if (body.windows !== undefined) {
        try { windows = Array.isArray(body.windows) ? body.windows : (String(body.windows).trim() === '' || String(body.windows).trim().toLowerCase() === 'always' ? [] : parseWindowsText(String(body.windows))) }
        catch (e) { const err = new Error(e.message); err.status = 400; throw err }
      }
      cfg = { ...cfg, share, price_per_minute_usd: priced.price, windows,
        ...(body.timezone ? { timezone: String(body.timezone) } : {}), ...(body.mobility === 'mobile' || body.mobility === 'stationary' ? { mobility: body.mobility } : {}), ...(body.name ? { name: String(body.name).slice(0, 80) } : {}) }
      saveConfig(cfg, home)
      admission.limit = share.max_parallel_jobs
      const offer = await pushOffer()
      return { saved: true, enabled: offer?.enabled ?? false, price_per_minute_usd: cfg.price_per_minute_usd, share: cfg.share, windows_text: windowsToText(cfg.windows) }
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

  const ui = startLocalUi({ port: Number(env.VERSUM_NODE_HEALTH_PORT ?? HEALTH_PORT), ctl, log, intervalSeconds: cfg.heartbeat_seconds })
  await refreshRuntime()
  if (!state.rtd.ok) for (const r of state.rtd.reasons) log(`runtime: ${r}`)
  else log(`runtime: ${state.rtd.name} ${state.rtd.version} ${state.rtd.rootless ? 'rootless' : 'ROOTFUL (allowed by the owner)'}`)
  await rescan().catch((e) => log(`scan failed: ${e.message}`))

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
    hub = hub ?? createHub({ baseUrl: cfg.hub, key: cfg.key, log })
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
      const freeDisk = (await import('./scan.mjs')).diskFreeMb(jobsDir(home))
      const fullScan = beats % 10 === 1 || (state.scan && freeDisk !== null && Math.abs((state.scan.disk_free_mb ?? 0) - freeDisk) > 1024)
      if (fullScan) await rescan().catch(() => null)
      try {
        await hub.heartbeat({ status: state.draining ? 'draining' : state.running.size ? 'working' : cfg.paused ? 'paused' : 'idle', interval_seconds: cfg.heartbeat_seconds, timezone: cfg.timezone, app: `versum-node/${NODE_VERSION}`, ...(fullScan && state.scan ? { resources: state.scan } : {}) })
        state.lastBeatAt = new Date().toISOString(); state.lastBeatOk = true; state.lastError = null
      } catch (e) { state.lastBeatOk = false; state.lastError = e.message; log(`heartbeat failed: ${e.message}`) }
      if (beats % 4 === 0) await readEarnings()
    }
    const tryLease = async () => {
      if (state.draining || cfg.paused || !admission.canStart() || cfg.price_per_minute_usd == null) return false
      if (!state.rtd?.ok) return false
      if (!windowOpen(cfg.windows, cfg.timezone)) return false
      let m
      try { m = await hub.lease({ free: { cpu_cores: cfg.share.cpu_cores ?? state.scan?.cpu_cores, ram_mb: cfg.share.ram_mb ?? state.scan?.ram_mb, disk_mb: cfg.share.disk_mb ?? state.scan?.disk_free_mb, gpu: cfg.share.gpu, network: cfg.share.allow_network } }) }
      catch (e) { if (e instanceof ApiError && e.status === 404) { log('the hub has no /jobs/lease yet — heartbeating only'); return false } log(`lease failed: ${e.message}`); return false }
      if (!m) return false
      let manifest
      try { manifest = validateManifest(m) } catch (e) { state.refused++; log(`manifest refused: ${e.message}`); if (m?.attempt_id) await hub.release(m.attempt_id, { reason_code: 'manifest_invalid', detail: String(e.message).slice(0, 300) }).catch(() => {}); return false }
      const why = fitsShare(manifest, { share: cfg.share, found: state.scan })
      if (why) { state.refused++; log(`lease ${manifest.attempt_id} refused: ${why}`); await hub.release(manifest.attempt_id, { reason_code: 'capacity', detail: why }).catch(() => {}); return false }
      state.leases++
      admission.start(manifest.attempt_id, { job_id: manifest.job_id })
      state.running.set(manifest.attempt_id, { attempt_id: manifest.attempt_id, job_id: manifest.job_id, since: new Date().toISOString(), note: 'starting', price_per_minute_usd: manifest.price_per_minute_usd })
      log(`lease ${manifest.attempt_id}: job ${manifest.job_id} piece ${manifest.piece_id} · ${manifest.kind} · ${manifest.limits.cpu_cores} cores / ${manifest.limits.ram_mb} MB / ${manifest.limits.time_limit_minutes} min · $${manifest.price_per_minute_usd}/min`)
      const { rt, name: runtime } = state.rtd
      runAttempt({ manifest, share: cfg.share, rt, runtime, home, hub, egressDir: join(APP_ROOT, 'egress'), log, stallMs: Number(env.VERSUM_NODE_STALL_MINUTES ?? 15) * 60_000, onStatus: (s) => { const r = state.running.get(manifest.attempt_id); if (r) { r.note = s.note; r.cpu_seconds = s.cpuSeconds } } })
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
      if (!state.draining) { let n = 0; while (n < 4 && (await tryLease())) n++ }
      if (state.draining && !state.running.size) return
      await sleep(cfg.heartbeat_seconds * 1000)
    }
  }
}

export function readJsonFile(p) { return JSON.parse(readFileSync(p, 'utf8')) }
