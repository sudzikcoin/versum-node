/**
 * 0.4.4 — the GPU probe the node runs on itself: can CUDA be reached from INSIDE the sandbox on this machine?
 *
 * The AppContainer has zero capabilities; the driver's user-mode DLLs are readable by ALL APPLICATION PACKAGES on
 * a stock Windows, but whether the driver's kernel-mode door admits a low-box token is written nowhere public.
 * So the node asks the machine, the way probe/gpu_probe.ps1 does by hand: probe/gpu_probe.py runs twice with the
 * exact environment a job gets — once bare (the owner's token), once through the executor (AppContainer + Job
 * Object) — and the two result.json files are compared step by step.
 *
 *   stage 'driver'  first start, as soon as an NVIDIA GPU with a CUDA driver is found and the Python tree is granted:
 *                   the step that must pass inside is `nvcuda` (ctypes nvcuda.dll → cuInit → cuCtxCreate). No
 *                   package is needed, the answer costs a few seconds and goes out on the next heartbeat.
 *   stage 'torch'   once the GPU package set is `ok` (lib/pylib-gpu.mjs): the step that must pass inside is
 *                   `torch` (a 2048×2048 matmul on the device). Only this verdict lets the node take GPU jobs.
 *
 * Verdicts (heartbeat `gpu_probe`): appcontainer_ok | blocked | no_gpu. A machine without an NVIDIA GPU answers
 * no_gpu without running anything. The verdict is cached in <state>/gpu-probe.json keyed by driver, CUDA version,
 * stage and the package stamp, so a restart does not probe again; `versum-node gpu-check` always does.
 * Pure: probeVerdict, describeGpuProbe, probeManifest. Everything that runs lives in runGpuProbe().
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nativeEnv } from './native.mjs'
import { gpuJobEnv } from './pylib-gpu.mjs'
import { validateManifest } from './manifest.mjs'
import { runAttempt } from './runner.mjs'

const execFileP = promisify(execFile)
export const PROBE_FILE = 'gpu-probe.json'
export const VERDICTS = ['appcontainer_ok', 'blocked', 'no_gpu']
const STEP = { driver: 'nvcuda', torch: 'torch' }

const firstLine = (s) => String(s ?? '').trim().split('\n').pop()?.slice(0, 300) ?? ''

/**
 * Pure: the verdict from the two runs. `bare` / `sandboxed` are the probe's result.json objects (sandboxed may be
 * null when the sandboxed interpreter wrote nothing). Returns { verdict, detail, step }.
 */
export function probeVerdict({ gpu, stage = 'driver', bare = null, sandboxed = null, sandboxExit = null, sandboxStderr = '' }) {
  const step = STEP[stage] ?? 'nvcuda'
  if (!gpu || gpu.vendor !== 'nvidia' || !gpu.cuda) return { verdict: 'no_gpu', detail: gpu?.model ? `${gpu.model}: ${gpu.vendor === 'nvidia' ? 'no CUDA driver found' : 'not an NVIDIA GPU'}` : 'no NVIDIA GPU on this machine', step: null }
  if (!bare) return { verdict: 'no_gpu', detail: 'the probe wrote no result even outside the sandbox', step }
  if (!bare.nvcuda?.ok) {
    const e = bare.nvcuda?.error ?? 'nvcuda failed'
    return { verdict: 'no_gpu', detail: `the driver does not answer even outside the sandbox: ${e}`, step }
  }
  if (step === 'torch' && !bare.torch?.ok) return { verdict: 'blocked', detail: `the GPU package set fails even outside the sandbox: ${bare.torch?.error ?? 'torch failed'}`, step, set_broken: true }
  if (!sandboxed) return { verdict: 'blocked', detail: `the sandboxed interpreter wrote no result (exit ${sandboxExit ?? '?'})${sandboxStderr ? `: ${firstLine(sandboxStderr)}` : ''} — 0xC0000135 means a DLL it may not read`, step }
  const s = sandboxed[step]
  if (s?.ok) {
    const detail = step === 'torch'
      ? `torch ${s.version ?? ''} matmul on ${s.device ?? 'the device'} inside the AppContainer in ${s.matmul_ms ?? '?'} ms`
      : `cuInit and cuCtxCreate ok inside the AppContainer (${sandboxed.nvcuda?.name ?? gpu.model}, driver CUDA ${sandboxed.nvcuda?.driver_cuda ?? gpu.cuda})`
    return { verdict: 'appcontainer_ok', detail, step }
  }
  const failing = !sandboxed.nvcuda?.ok ? `nvcuda: ${sandboxed.nvcuda?.error ?? 'failed'}` : `${step}: ${s?.error ?? 'failed'}`
  return { verdict: 'blocked', detail: `bare passes, inside the AppContainer the first failing call is ${failing}`, step }
}

/** Pure: the local page's line. */
export function describeGpuProbe(p) {
  if (!p) return null
  if (p.status === 'running') return `checking whether CUDA works inside the sandbox (${p.stage})…`
  if (p.verdict === 'appcontainer_ok') return `GPU inside the sandbox: works — ${p.detail}`
  if (p.verdict === 'blocked') return `GPU inside the sandbox: BLOCKED — ${p.detail}`
  if (p.verdict === 'no_gpu') return `GPU: none usable (${p.detail})`
  return null
}

/** Pure: the manifest the executor runs for the sandboxed half — the probe script, no network, GPU env only in the torch stage. */
export function probeManifest({ id, stage, probePath, cpuCores = 2, ramMb }) {
  const torch = stage === 'torch'
  const m = validateManifest({
    attempt_id: id, piece_id: id, job_id: id, kind: 'python',
    image: 'ghcr.io/sudzikcoin/versum-python@sha256:' + 'f'.repeat(64),
    command: ['python', '/job/in/gpu_probe.py'], env: { VERSUM_PROBE_MODE: 'appcontainer' }, args: { probe: 'gpu', stage },
    limits: { cpu_cores: cpuCores, ram_mb: ramMb ?? (torch ? 6144 : 1024), disk_mb: 1024, gpu: torch, network: false, time_limit_minutes: torch ? 10 : 3 },
    inputs: [{ name: 'gpu_probe.py', url: 'https://localhost/probe', size_bytes: 0 }], price_per_minute_usd: 0,
  })
  m.inputs[0].path = probePath
  return m
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

/**
 * Run the probe (or return the cached verdict). Returns { verdict, detail, stage, step, at, bare, sandboxed, cached }.
 *   gpu        the detection block (lib/gpu-detect.mjs)
 *   exec       the executor (createNativeExecutor) — the sandboxed half; null → skipped (reported as blocked)
 *   pythonExe/pythonDir  the embedded interpreter — the bare half
 *   gpuDir/pylibDir/stamp   the package folders for the torch stage
 *   force      ignore the cache (gpu-check)
 */
export async function runGpuProbe({ home, appRoot, stateDir, gpu, stage = 'driver', exec = null, pythonExe, pythonDir, pylibDir = null, gpuDir = null, stamp = null, cpuCores = 2, ramMb = null, platform = process.platform, hostEnv = process.env, log = () => {}, force = false, execFn = execFileP, progress = null, nodeVersion = null }) {
  const cacheFile = join(stateDir, PROBE_FILE)
  const key = { driver: gpu?.driver ?? null, cuda: gpu?.cuda ?? null, model: gpu?.model ?? null, stage, stamp: stage === 'torch' ? stamp : null }
  if (!force) {
    const c = readJson(cacheFile)
    if (c && VERDICTS.includes(c.verdict) && JSON.stringify(c.key) === JSON.stringify(key)) return { ...c, cached: true }
  }
  // no NVIDIA GPU with a CUDA driver: nothing to run, the answer is the detection
  if (!gpu || gpu.vendor !== 'nvidia' || !gpu.cuda) {
    const v = probeVerdict({ gpu, stage })
    const out = { ...v, stage, key, at: new Date().toISOString(), bare: null, sandboxed: null, cached: false, node_version: nodeVersion }
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(out, null, 1)) } catch {}
    return out
  }
  if (progress) Object.assign(progress, { status: 'running', stage })
  const probePath = join(appRoot, 'probe', 'gpu_probe.py')
  if (!existsSync(probePath)) throw new Error(`probe missing: ${probePath}`)
  log(`gpu probe: ${stage} stage — ${gpu.model}, driver CUDA ${gpu.cuda}: bare, then inside the sandbox`)
  // ── bare: the owner's token, the job's environment ──
  const bareDir = join(home, 'jobs', `gpu-probe-bare-${Date.now()}`)
  let bare = null
  try {
    for (const d of ['in', 'out', 'tmp']) mkdirSync(join(bareDir, d), { recursive: true })
    const fake = { job_id: 'probe', piece_id: 'probe', attempt_id: 'probe', env: { VERSUM_PROBE_MODE: 'bare' }, limits: { cpu_cores: cpuCores } }
    let env = nativeEnv(fake, { jobDir: bareDir, pythonDir, pylibDir, platform, hostEnv })
    if (stage === 'torch' && gpuDir) env = gpuJobEnv(env, { gpuDir, pylibDir, platform })
    try { await execFn(pythonExe, ['-s', '-B', '-u', '-X', 'utf8', probePath], { env, cwd: bareDir, timeout: 600_000, windowsHide: true, maxBuffer: 1 << 20 }) }
    catch (e) { if (e.code === 'ETIMEDOUT' || e.killed) log(`gpu probe: bare run timed out`) /* non-zero exits are the probe's own verdict codes */ }
    bare = readJson(join(bareDir, 'out', 'result.json'))
  } finally { rmSync(bareDir, { recursive: true, force: true }) }
  for (const k of ['nvcuda', 'torch', 'cupy', 'numba']) if (bare?.[k]) log(`gpu probe: bare ${k}: ${bare[k].ok ? 'ok' : 'FAIL ' + bare[k].error}`)
  // ── sandboxed: the executor, exactly as a job runs ──
  let sandboxed = null, sandboxExit = null, sandboxStderr = ''
  // the sandboxed half only when the bare one passed (otherwise the answer is the machine's, not the sandbox's); `force` runs it anyway (gpu-check: prove the round trip even without a GPU)
  if (exec && (force || (bare?.nvcuda?.ok && (stage !== 'torch' || bare?.torch?.ok)))) {
    const id = (globalThis.crypto ?? (await import('node:crypto')).webcrypto).randomUUID()
    const manifest = probeManifest({ id, stage, probePath, cpuCores, ramMb })
    const r = await runAttempt({ manifest, share: { gpu: stage === 'torch', allow_network: false }, exec, home, log, local: true })
    sandboxExit = r.exit_code; sandboxStderr = r.stderr_tail ?? ''
    if (r.job_dir) { sandboxed = readJson(join(r.job_dir, 'out', 'result.json')); rmSync(r.job_dir, { recursive: true, force: true }) }
    for (const k of ['nvcuda', 'torch', 'cupy', 'numba']) if (sandboxed?.[k]) log(`gpu probe: sandbox ${k}: ${sandboxed[k].ok ? 'ok' : 'FAIL ' + sandboxed[k].error}`)
  }
  const v = probeVerdict({ gpu, stage, bare, sandboxed, sandboxExit, sandboxStderr })
  const out = { ...v, stage, key, at: new Date().toISOString(), bare, sandboxed, sandbox_exit: sandboxExit, cached: false, node_version: nodeVersion }
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(out, null, 1)) } catch {}
  log(`gpu probe: ${v.verdict} — ${v.detail}`)
  return out
}
