/**
 * One attempt = one fresh container, and nothing of it remains afterwards.
 *
 *   prepare   jobs/<attempt>/{in,out}, piece.json (ids + args), inputs downloaded and checked
 *   pull      the image, by digest only; refused above the size cap
 *   run       containerArgs() posture; a per-job proxy only when asked AND allowed
 *   watch     the pulse heartbeats cpu seconds to the hub and kills a stalled job; the time limit kills too
 *   collect   /job/out → uploaded one file at a time; the stderr tail travels with the report
 *   report    finish { exit_code, outcome, wall_seconds, cpu_seconds, outputs }
 *   wipe      container removed, proxy removed, job directory deleted — always, even on failure
 *
 * `local: true` (versum-node run-local) skips the hub: inputs come from `path`, outputs stay in out/.
 * (From versum-worker's lib/docker.mjs and the metering/wipe parts of bin/worker.mjs.)
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import os from 'node:os'
import { containerArgs } from './manifest.mjs'
import { makeMeter } from './metering.mjs'
import { startPulse } from './pulse.mjs'
import { startJobProxy, stopJobProxy, proxyLog } from './egress.mjs'

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', srt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', xml: 'application/xml' }
export const contentTypeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream'

export const DEFAULT_IMAGE_CAP_BYTES = 10 * 1024 ** 3
export const MAX_OUTPUT_FILES = 1000

/** Files under out/, recursively, with their relative names and sizes; a symlink is skipped, never followed. */
export function listOutputs(outDir, { maxFiles = MAX_OUTPUT_FILES } = {}) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push({ path: p, name: relative(outDir, p).split('\\').join('/'), size: statSync(p).size })
    }
  }
  if (existsSync(outDir)) walk(outDir)
  return out
}

/** Pure: the outcome word for the report. */
export function outcomeOf({ exitCode, timedOut, stalled }) {
  if (timedOut) return 'timeout'
  if (stalled) return 'failed'
  return exitCode === 0 ? 'succeeded' : 'failed'
}

export async function runAttempt({ manifest, share, rt, runtime, home, hub = null, egressDir, log = () => {}, local = false, imageCapBytes = DEFAULT_IMAGE_CAP_BYTES, stallMs = 900_000, onStatus = () => {} }) {
  const id = manifest.attempt_id
  const jobDir = join(home, 'jobs', id)
  const name = `versum-job-${id}`
  const { uid, gid } = os.userInfo()
  const t0 = Date.now()
  let proxy = null, child = null, timedOut = false, exitCode = null, cpuSeconds = null, uploaded = [], stderr = [], outputs = []
  const status = { note: 'preparing', progressAt: Date.now(), cpuSeconds: null }
  const note = (n) => { status.note = n; status.progressAt = Date.now(); onStatus({ ...status }); log(`attempt ${id}: ${n}`) }
  const wipe = async () => {
    await rt.run(['rm', '-f', name]).catch(() => {})
    await stopJobProxy(rt, proxy).catch(() => {})
    if (!local) rmSync(jobDir, { recursive: true, force: true })
  }
  try {
    // ── prepare ──
    rmSync(jobDir, { recursive: true, force: true })
    mkdirSync(join(jobDir, 'in'), { recursive: true, mode: 0o700 })
    mkdirSync(join(jobDir, 'out'), { recursive: true, mode: 0o700 })
    writeFileSync(join(jobDir, 'piece.json'), JSON.stringify({ job_id: manifest.job_id, piece_id: manifest.piece_id, attempt_id: id, args: manifest.args }, null, 2))
    const diskCap = manifest.limits.disk_mb ? manifest.limits.disk_mb * 1048576 : null
    let inBytes = 0
    for (const f of manifest.inputs) {
      note(`input ${f.name} (${f.size_bytes} bytes)`)
      const dest = join(jobDir, 'in', f.name)
      if (local && f.path) { copyFileSync(f.path, dest); inBytes += statSync(dest).size }
      else { const r = await hub.download(f.url, dest, { maxBytes: diskCap ? Math.min(f.size_bytes * 1.01 + 1024, diskCap - inBytes) : f.size_bytes * 1.01 + 1024, sha256: f.sha256 }); inBytes += r.size }
      if (diskCap && inBytes > diskCap) throw new Error(`inputs exceed the job's disk limit (${manifest.limits.disk_mb} MB)`)
    }
    // ── pull ──
    note(`pulling ${manifest.image.split('@')[0]}@${manifest.image.split('@sha256:')[1].slice(0, 12)}…`)
    await rt.run(['pull', '-q', manifest.image], { timeoutMs: 900_000 })
    const size = Number(await rt.run(['image', 'inspect', '-f', '{{.Size}}', manifest.image]).catch(() => '0'))
    if (size > imageCapBytes) throw new Error(`image is ${Math.round(size / 1048576)} MB, above the node's cap of ${Math.round(imageCapBytes / 1048576)} MB`)
    // ── network ──
    if (manifest.limits.network) {
      if (!share.allow_network) throw new Error('job needs network, owner has not allowed it')
      proxy = await startJobProxy(rt, runtime, id, { egressDir, log })
    }
    // ── run ──
    const args = containerArgs({ manifest, jobDir, name, uid, gid, runtime, network: proxy, gpu: share.gpu })
    log(`attempt ${id}: ${rt.bin} ${args.map((a) => (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) ? a.replace(/=.*$/, '=…') : a)).join(' ')}`)   // env values never reach the log
    note('running')
    const meter = makeMeter({ rt, runtime, name })
    const timeoutMs = manifest.limits.time_limit_minutes * 60_000
    const tRun = Date.now()
    child = rt.spawn(args)
    const timer = setTimeout(() => { timedOut = true; log(`attempt ${id}: time limit ${manifest.limits.time_limit_minutes} min reached — killing`); rt.run(['kill', name]).catch(() => {}) }, timeoutMs)
    createInterface({ input: child.stdout }).on('line', (l) => { status.progressAt = Date.now(); if (/^PROGRESS\b/.test(l)) status.note = l.slice(0, 200) })
    createInterface({ input: child.stderr }).on('line', (l) => { stderr.push(l.slice(0, 500)); if (stderr.length > 100) stderr.shift() })
    // the cgroup vanishes with the process, so cpu is sampled every second while it runs; the last sample is the figure
    let lastCpu = null, closed = false
    const sampler = (async () => { while (!closed) { const c = await meter.cpuSeconds(); if (c !== null && c !== lastCpu) { lastCpu = c; status.cpuSeconds = c; status.progressAt = Date.now() } await new Promise((r) => setTimeout(r, 1000)) } })()
    const pulse = startPulse({
      intervalMs: 30_000, stallMs, log: (m) => log(`attempt ${id}: ${m}`),
      status: () => ({ ...status, cpuSeconds: lastCpu }),
      send: async (ev) => { if (hub && !local) await hub.attemptHeartbeat(id, { ...ev, cpu_seconds: lastCpu }) },
      onStall: async () => { await rt.run(['kill', name]).catch(() => {}) },
    })
    exitCode = await new Promise((resolve) => child.on('close', resolve))
    clearTimeout(timer); pulse.stop(); closed = true
    cpuSeconds = (await meter.cpuSeconds()) ?? lastCpu
    await sampler.catch(() => {})
    const wallSeconds = (Date.now() - tRun) / 1000
    const stalled = pulse.stalled
    const outcome = outcomeOf({ exitCode, timedOut, stalled })
    note(`exited ${exitCode}${timedOut ? ' (time limit)' : stalled ? ' (stalled)' : ''} after ${Math.round(wallSeconds)} s, cpu ${cpuSeconds == null ? '?' : cpuSeconds.toFixed(1)} s`)
    // ── collect ──
    outputs = listOutputs(join(jobDir, 'out'))
    const outBytes = outputs.reduce((s, f) => s + f.size, 0)
    if (diskCap && outBytes > diskCap) { log(`attempt ${id}: outputs ${outBytes} bytes exceed the disk limit — not uploaded`); outputs = [] }
    if (hub && !local) {
      for (const f of outputs) {
        try { await hub.uploadOutput(id, f.path, { name: f.name, contentType: contentTypeOf(f.name) }); uploaded.push(f.name) }
        catch (e) { log(`attempt ${id}: upload of ${f.name} failed: ${e.message}`) }
      }
    } else uploaded = outputs.map((f) => f.name)
    const egressLog = proxy ? await proxyLog(rt, proxy) : null
    if (egressLog) { try { mkdirSync(join(home, 'state', 'egress'), { recursive: true, mode: 0o700 }); writeFileSync(join(home, 'state', 'egress', `${id}.log`), egressLog, { mode: 0o600 }) } catch {} }
    const report = { exit_code: exitCode, outcome, wall_seconds: Math.round(wallSeconds * 1000) / 1000, cpu_seconds: cpuSeconds, outputs: uploaded, failure_reason: timedOut ? 'time limit reached' : stalled ? 'no progress (stalled)' : exitCode !== 0 ? `exit ${exitCode}` : null, stderr_tail: stderr.slice(-40).join('\n').slice(0, 8000) }
    // ── report ──
    if (hub && !local) await hub.finish(id, report)
    return { ...report, job_dir: local ? jobDir : null }
  } catch (e) {
    const wallSeconds = (Date.now() - t0) / 1000
    const report = { exit_code: exitCode, outcome: 'failed', wall_seconds: Math.round(wallSeconds), cpu_seconds: cpuSeconds, outputs: uploaded, failure_reason: String(e.message).slice(0, 500), stderr_tail: stderr.slice(-40).join('\n').slice(0, 8000) }
    log(`attempt ${id}: FAILED — ${e.message}`)
    if (hub && !local) await hub.finish(id, report).catch((e2) => log(`attempt ${id}: finish failed too: ${e2.message}`))
    return { ...report, job_dir: local ? jobDir : null }
  } finally {
    await wipe()
    log(`attempt ${id}: wiped (${Math.round((Date.now() - t0) / 1000)} s total)`)
  }
}
