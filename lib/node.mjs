/**
 * The daemon: one loop on the heartbeat cadence.
 *   every beat     heartbeat to the hub with status and (every 10th beat, or when free disk moved) the scan
 *   when free      inside a window, below max_parallel_jobs, not draining → ask for a lease; a manifest is
 *                  validated, checked against the share, then run in the background
 *   on SIGTERM     stop leasing, let running attempts finish (the time limit bounds the wait), exit
 * Nothing listens except the local status page on 127.0.0.1 (health.mjs).
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
import { startHealthServer } from './health.mjs'
import { jobsDir, ensureHome, HEALTH_PORT } from './config.mjs'

export const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))

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

/** The offer as the hub wants it on PUT /me/node, from the config. */
export function offerFromConfig(cfg, resources = null) {
  return {
    ...(resources ? { resources } : {}),
    share: { cpu_cores: cfg.share.cpu_cores, ram_mb: cfg.share.ram_mb, disk_mb: cfg.share.disk_mb, gpu: cfg.share.gpu, max_parallel_jobs: cfg.share.max_parallel_jobs, max_job_minutes: cfg.share.max_job_minutes, allow_network: cfg.share.allow_network },
    price_per_minute_usd: cfg.price_per_minute_usd,
    mobility: cfg.mobility,
    windows: cfg.windows.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end, ...(w.timezone ? { timezone: w.timezone } : {}) })),
    timezone: cfg.timezone,
    enabled: cfg.price_per_minute_usd != null,
  }
}

export async function startNode({ home, cfg, log, once = false }) {
  ensureHome(home)
  const rtd = await detectRuntime(cfg.runtime)
  if (!rtd.ok) { for (const r of rtd.reasons) log(`runtime: ${r}`); throw new Error('no usable container runtime — the node cannot run jobs') }
  const { rt, name: runtime } = rtd
  log(`runtime: ${runtime} ${rtd.version} ${rtd.rootless ? 'rootless' : 'ROOTFUL (accepted by VERSUM_NODE_ALLOW_ROOTFUL)'}`)
  await reapContainers(rt, log)
  const hub = createHub({ baseUrl: cfg.hub, key: cfg.key, log })
  const admission = createAdmission({ limit: cfg.share.max_parallel_jobs })
  const state = { startedAt: new Date().toISOString(), lastBeatAt: null, lastBeatOk: null, lastError: null, running: new Map(), finished: [], draining: false, leases: 0, refused: 0, scan: null, hub: cfg.hub }
  const me = await hub.me()
  log(`paired as ${me.executor?.display_name ?? me.executor?.id} on ${cfg.hub}`)
  // the whole offer from the config, with a fresh scan; the hub keeps the price the owner set here
  state.scan = await scan({ jobsDir: jobsDir(home), runtime: rtd })
  const offer = await hub.setNode(offerFromConfig(cfg, state.scan))
  log(`offer: ${offer.enabled ? 'ON' : 'off'} · $${offer.price_per_minute_usd ?? '—'}/min · share ${JSON.stringify(offer.share)} · ${offer.windows?.length ? offer.windows.length + ' window(s)' : 'always'} · open now: ${offer.window_open_now}`)
  if (!offer.enabled) log('the node is OFF (no price set): run `versum-node offer --price=0.02` to start taking jobs')
  const health = startHealthServer({ port: Number(process.env.VERSUM_NODE_HEALTH_PORT ?? HEALTH_PORT), state: () => ({ ...state, running: [...state.running.values()] }), log })
  let beats = 0
  const stop = () => { if (!state.draining) { state.draining = true; log(`draining: no new leases; ${state.running.size} running`) } }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)

  const beat = async () => {
    beats++
    const freeDisk = (await import('./scan.mjs')).diskFreeMb(jobsDir(home))
    const fullScan = beats % 10 === 1 || (state.scan && freeDisk !== null && Math.abs((state.scan.disk_free_mb ?? 0) - freeDisk) > 1024)
    if (fullScan) state.scan = await scan({ jobsDir: jobsDir(home), runtime: rtd })
    try {
      await hub.heartbeat({ status: state.draining ? 'draining' : state.running.size ? 'working' : 'idle', interval_seconds: cfg.heartbeat_seconds, timezone: cfg.timezone, app: `versum-node/${state.scan?.node_version ?? '0.1.0'}`, ...(fullScan ? { resources: state.scan } : {}) })
      state.lastBeatAt = new Date().toISOString(); state.lastBeatOk = true; state.lastError = null
    } catch (e) { state.lastBeatOk = false; state.lastError = e.message; log(`heartbeat failed: ${e.message}`) }
  }
  const tryLease = async () => {
    if (state.draining || !admission.canStart() || cfg.price_per_minute_usd == null) return false
    if (!windowOpen(cfg.windows, cfg.timezone)) return false
    let m
    try { m = await hub.lease({ free: { cpu_cores: cfg.share.cpu_cores ?? state.scan?.cpu_cores, ram_mb: cfg.share.ram_mb ?? state.scan?.ram_mb, disk_mb: cfg.share.disk_mb ?? state.scan?.disk_free_mb, gpu: cfg.share.gpu, network: cfg.share.allow_network, running: state.running.size } }) }
    catch (e) { if (e instanceof ApiError && e.status === 404) { log('the hub has no /jobs/lease yet (block 4) — heartbeating only'); return false } log(`lease failed: ${e.message}`); return false }
    if (!m) return false
    let manifest
    try { manifest = validateManifest(m) } catch (e) { state.refused++; log(`manifest refused: ${e.message}`); if (m?.attempt_id) await hub.release(m.attempt_id, { reason_code: 'manifest_invalid', detail: String(e.message).slice(0, 300) }).catch(() => {}); return false }
    const why = fitsShare(manifest, { share: cfg.share, found: state.scan })
    if (why) { state.refused++; log(`lease ${manifest.attempt_id} refused: ${why}`); await hub.release(manifest.attempt_id, { reason_code: 'capacity', detail: why }).catch(() => {}); return false }
    state.leases++
    admission.start(manifest.attempt_id, { job_id: manifest.job_id })
    state.running.set(manifest.attempt_id, { attempt_id: manifest.attempt_id, job_id: manifest.job_id, since: new Date().toISOString(), note: 'starting', price_per_minute_usd: manifest.price_per_minute_usd })
    log(`lease ${manifest.attempt_id}: job ${manifest.job_id} piece ${manifest.piece_id} · ${manifest.kind} · ${manifest.limits.cpu_cores} cores / ${manifest.limits.ram_mb} MB / ${manifest.limits.time_limit_minutes} min · $${manifest.price_per_minute_usd}/min`)
    runAttempt({ manifest, share: cfg.share, rt, runtime, home, hub, egressDir: join(APP_ROOT, 'egress'), log, stallMs: Number(process.env.VERSUM_NODE_STALL_MINUTES ?? 15) * 60_000, onStatus: (s) => { const r = state.running.get(manifest.attempt_id); if (r) r.note = s.note } })
      .then((r) => { state.finished.push({ attempt_id: manifest.attempt_id, job_id: manifest.job_id, at: new Date().toISOString(), outcome: r.outcome, wall_seconds: r.wall_seconds, cpu_seconds: r.cpu_seconds, outputs: r.outputs.length }); if (state.finished.length > 50) state.finished.shift() })
      .catch((e) => log(`attempt ${manifest.attempt_id}: unexpected — ${e.message}`))
      .finally(() => { admission.end(manifest.attempt_id); state.running.delete(manifest.attempt_id) })
    return true
  }

  if (once) {
    await beat(); const got = await tryLease()
    if (!got) log('once: nothing to run')
    while (state.running.size) await new Promise((r) => setTimeout(r, 1000))
    health.close(); return
  }
  while (true) {
    await beat()
    if (!state.draining) { let n = 0; while (n < 4 && (await tryLease())) n++ }
    if (state.draining && !state.running.size) break
    await new Promise((r) => setTimeout(r, cfg.heartbeat_seconds * 1000))
  }
  health.close()
  log('stopped')
}

export function readJsonFile(p) { return JSON.parse(readFileSync(p, 'utf8')) }
