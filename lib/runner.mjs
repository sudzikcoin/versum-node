/**
 * One attempt, and nothing of it remains afterwards. The runner is the same for both executors:
 *
 *   prepare   jobs/<attempt>/{in,out}, piece.json (ids + args), inputs downloaded and checked
 *   exec.prepare   container: pull the image by digest (refused above the size cap); native: nothing
 *   exec.start     container: containerArgs() posture, per-job proxy only when asked AND allowed
 *                  native: the embedded Python inside the OS sandbox (lib/native.mjs)
 *   watch     the pulse heartbeats cpu seconds to the hub and kills a stalled job; the time limit kills too
 *   collect   out/ → uploaded one file at a time; the stderr tail travels with the report
 *   report    finish { exit_code, outcome, wall_seconds, cpu_seconds, outputs }
 *   wipe      exec.cleanup (container / proxy / AppContainer profile gone), job directory deleted — always
 *
 * `local: true` (versum-node run-local) skips the hub: inputs come from `path`, outputs stay in out/.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { startPulse } from './pulse.mjs'

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', srt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', xml: 'application/xml' }
export const contentTypeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream'

export { DEFAULT_IMAGE_CAP_BYTES } from './container.mjs'
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

/** Pure: a process exit code as a signed 32-bit int. Windows returns a DWORD (e.g. 0xC0000135 = 3221225781),
 * which overflows the hub's `exit_code integer` column; two's-complement it into range, as the shell would show it. */
export function toInt32(code) {
  if (code == null || !Number.isFinite(Number(code))) return null
  const n = Math.trunc(Number(code))
  return n > 0x7fffffff || n < -0x80000000 ? (n | 0) : n
}

/** Pure: the outcome word for the report. */
export function outcomeOf({ exitCode, timedOut, stalled }) {
  if (timedOut) return 'timeout'
  if (stalled) return 'failed'
  return exitCode === 0 ? 'succeeded' : 'failed'
}

/** Pure: lines the sandbox helper writes about itself are the owner's, not the buyer's stderr. */
export const isSandboxLine = (l) => /^\[sandbox\]/.test(l)

export async function runAttempt({ manifest, share, exec, home, hub = null, log = () => {}, local = false, stallMs = 900_000, onStatus = () => {} }) {
  const id = manifest.attempt_id
  const jobDir = join(home, 'jobs', id)
  const t0 = Date.now()
  let run = null, timedOut = false, exitCode = null, cpuSeconds = null, uploaded = [], stderr = [], outputs = []
  const status = { note: 'preparing', progressAt: Date.now(), cpuSeconds: null }
  const note = (n) => { status.note = n; status.progressAt = Date.now(); onStatus({ ...status }); log(`attempt ${id}: ${n}`) }
  const wipe = async () => {
    await exec.cleanup({ run, manifest, jobDir }).catch((e) => log(`attempt ${id}: cleanup: ${e.message}`))
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
    await exec.prepare({ manifest, note })
    // ── run ──
    note('running')
    const timeoutMs = manifest.limits.time_limit_minutes * 60_000
    const tRun = Date.now()
    run = await exec.start({ manifest, jobDir, share, onStatus: (s) => { status.progressAt = Date.now(); if (s?.note) status.note = s.note } })
    const { child } = run
    const timer = setTimeout(() => { timedOut = true; log(`attempt ${id}: time limit ${manifest.limits.time_limit_minutes} min reached — killing`); run.kill('time limit') }, timeoutMs)
    createInterface({ input: child.stdout }).on('line', (l) => { status.progressAt = Date.now(); if (/^PROGRESS\b/.test(l)) status.note = l.slice(0, 200) })
    createInterface({ input: child.stderr }).on('line', (l) => { if (isSandboxLine(l)) { log(`attempt ${id}: ${l}`); return } stderr.push(l.slice(0, 500)); if (stderr.length > 100) stderr.shift() })
    // cpu is sampled every second while it runs (a cgroup vanishes with the process); the last sample is the figure
    let lastCpu = null, closed = false
    const sampler = (async () => { while (!closed) { const c = await run.cpuSeconds().catch(() => null); if (c !== null && c !== lastCpu) { lastCpu = c; status.cpuSeconds = c; status.progressAt = Date.now() } await new Promise((r) => setTimeout(r, 1000)) } })()
    const pulse = startPulse({
      intervalMs: 30_000, stallMs, log: (m) => log(`attempt ${id}: ${m}`),
      status: () => ({ ...status, cpuSeconds: lastCpu }),
      send: async (ev) => { if (hub && !local) await hub.attemptHeartbeat(id, { ...ev, cpu_seconds: lastCpu }) },
      onStall: async () => { run.kill('stalled') },
    })
    exitCode = await new Promise((resolve) => child.on('close', (code, signal) => resolve(code ?? (signal ? 137 : null))))
    clearTimeout(timer); pulse.stop(); closed = true
    cpuSeconds = (await run.cpuSeconds().catch(() => null)) ?? lastCpu
    await sampler.catch(() => {})
    const wallSeconds = (Date.now() - tRun) / 1000
    const stalled = pulse.stalled
    const killedWhy = run.killedWhy
    const outcome = outcomeOf({ exitCode, timedOut, stalled: stalled || (!!killedWhy && !timedOut) })
    note(`exited ${exitCode}${timedOut ? ' (time limit)' : killedWhy ? ` (${killedWhy})` : stalled ? ' (stalled)' : ''} after ${Math.round(wallSeconds)} s, cpu ${cpuSeconds == null ? '?' : cpuSeconds.toFixed(1)} s`)
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
    const egressLog = await exec.egressLog({ run }).catch(() => null)
    if (egressLog) { try { mkdirSync(join(home, 'state', 'egress'), { recursive: true, mode: 0o700 }); writeFileSync(join(home, 'state', 'egress', `${id}.log`), egressLog, { mode: 0o600 }) } catch {} }
    const report = { exit_code: toInt32(exitCode), outcome, wall_seconds: Math.round(wallSeconds * 1000) / 1000, cpu_seconds: cpuSeconds, outputs: uploaded, failure_reason: timedOut ? 'time limit reached' : killedWhy ? `killed: ${killedWhy}` : stalled ? 'no progress (stalled)' : exitCode !== 0 ? `exit ${exitCode}` : null, stderr_tail: stderr.slice(-40).join('\n').slice(0, 8000) }
    // ── report ──
    if (hub && !local) await hub.finish(id, report)
    return { ...report, job_dir: local ? jobDir : null }
  } catch (e) {
    const wallSeconds = (Date.now() - t0) / 1000
    const report = { exit_code: toInt32(exitCode), outcome: 'failed', wall_seconds: Math.round(wallSeconds), cpu_seconds: cpuSeconds, outputs: uploaded, failure_reason: String(e.message).slice(0, 500), stderr_tail: stderr.slice(-40).join('\n').slice(0, 8000) }
    log(`attempt ${id}: FAILED — ${e.message}`)
    if (hub && !local) await hub.finish(id, report).catch((e2) => log(`attempt ${id}: finish failed too: ${e2.message}`))
    return { ...report, job_dir: local ? jobDir : null }
  } finally {
    await wipe()
    log(`attempt ${id}: wiped (${Math.round((Date.now() - t0) / 1000)} s total)`)
  }
}
