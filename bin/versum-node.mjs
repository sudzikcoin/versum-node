#!/usr/bin/env node
/**
 * versum-node — share your computer's spare compute by the minute.
 *
 *   versum-node scan                       what this machine has (nothing is sent)
 *   versum-node doctor                     runtime, scan, hub reachability — is this machine ready?
 *   versum-node pair <llk_key> [--hub=URL] [--name=…]      link to your Versum account (key from the site)
 *   versum-node offer [--cpu=4 --ram-gb=8 --disk-gb=20 --gpu=true --parallel=2 --max-job-minutes=240
 *                      --network=false --price=0.02 --mobility=stationary --windows="Mon-Fri 22:00-07:00"]
 *                                          what you share, at what price, when — saved and sent to the hub
 *   versum-node on | off                   start / stop taking jobs (your offer stays)
 *   versum-node status                     the offer as the hub stores it + earnings
 *   versum-node start                      run the node (the service calls this); unpaired, it waits for the key on the local page
 *   versum-node open                       print (and try to open) the local page http://127.0.0.1:3311/
 *   versum-node once                       one heartbeat, at most one job, exit
 *   versum-node run-local <manifest.json>  run a manifest without the hub (inputs by `path`); outputs stay in jobs/<id>/out
 *   versum-node prune                      remove leftover job containers and unused images
 *   versum-node sandbox-check              run the probe script in this machine's sandbox and say what it could NOT do
 *   versum-node gpu-check [--force]        0.4.4: does CUDA work inside the sandbox here? exit 0 works · 1 blocked · 2 no GPU
 *   versum-node version
 */
import { join } from 'node:path'
import { loadConfig, saveConfig, redactConfig, ensureHome, nodeHome, jobsDir, stateDir, offerPatchFromArgs, DEFAULT_HUB } from '../lib/config.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { detectRuntime, reapContainers, makeExecutor, describeRuntime } from '../lib/runtime.mjs'
import { probeVerdict } from '../lib/native.mjs'
import { scan, renderScan, NODE_VERSION } from '../lib/scan.mjs'
import { createHub } from '../lib/hub.mjs'
import { validateManifest } from '../lib/manifest.mjs'
import { runAttempt } from '../lib/runner.mjs'
import { startNode, offerFromConfig, readJsonFile, APP_ROOT } from '../lib/node.mjs'
import { log } from '../lib/log.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name) => { const a = rest.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null }
/** a bare switch: `--force` (0.4.4) */
const has = (name) => rest.includes(`--${name}`) || flag(name) !== null
const home = nodeHome()
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o, null, 2)) + '\n')

async function main() {
  switch (cmd) {
    case 'scan': {
      const c0 = loadConfig(home)
      const rtd = await detectRuntime(c0.runtime, { allowRootful: c0.allow_rootful === true, appRoot: APP_ROOT }).catch(() => null)
      const r = await scan({ jobsDir: jobsDir(ensureHome(home)), runtime: rtd?.name ? rtd : null })
      out(flag('json') !== null ? r : renderScan(r)); return
    }
    case 'doctor': {
      const cfg = loadConfig(home)
      const rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true, appRoot: APP_ROOT })
      out(`runtime  ${rtd.ok ? describeRuntime(rtd) + ' ✓' : rtd.name ? `${rtd.name} ${rtd.version} ROOTFUL ✗` : 'none ✗'}`)
      for (const r of rtd.reasons) out(`         ${r}`)
      out(renderScan(await scan({ jobsDir: jobsDir(ensureHome(home)), runtime: rtd.name ? rtd : null })))
      out(`config   ${cfg.key ? 'paired' : 'NOT paired (versum-node pair <key>)'} · hub ${cfg.hub} · price ${cfg.price_per_minute_usd ?? 'not set'}`)
      if (cfg.key) { try { const me = await createHub({ baseUrl: cfg.hub, key: cfg.key, log }).me(); out(`hub      ✓ ${me.executor?.display_name} (${me.executor?.id})`) } catch (e) { out(`hub      ✗ ${e.code ?? ''} ${e.message}`) } }
      const ready = rtd.ok && !!cfg.key && cfg.price_per_minute_usd != null
      out(ready ? 'ready' : `not ready${!rtd.ok ? ': no usable runtime' : !cfg.key ? ': not paired' : ': no price set'}`); process.exitCode = ready ? 0 : 1; return
    }
    case 'pair': {
      const key = rest.find((x) => !x.startsWith('--'))
      if (!key || !/^llk_[0-9A-Za-z]{32}$/.test(key)) throw new Error('usage: versum-node pair llk_<32 chars> [--hub=URL] [--name=…]  — the key is shown once on the site, "connect your computer"')
      const cfg = loadConfig(home)
      cfg.hub = flag('hub') ?? cfg.hub ?? DEFAULT_HUB; cfg.key = key; if (flag('name')) cfg.name = flag('name').slice(0, 80)
      const me = await createHub({ baseUrl: cfg.hub, key, log }).me()
      const p = saveConfig(cfg, home)
      out(`paired as ${me.executor?.display_name} (${me.executor?.id}) on ${cfg.hub}; config ${p} (mode 600)`)
      out('next: versum-node offer --price=0.02   (and --cpu/--ram-gb/--gpu/--windows to limit what you share)'); return
    }
    case 'offer': {
      const cfg = loadConfig(home)
      const patch = offerPatchFromArgs(rest)
      Object.assign(cfg, patch, { share: { ...cfg.share, ...(patch.share ?? {}) } })
      saveConfig(cfg, home)
      if (!cfg.key) { out('saved locally; pair first to send it to the hub'); return }
      const rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true, appRoot: APP_ROOT })
      const res = await scan({ jobsDir: jobsDir(home), runtime: rtd.name ? rtd : null })
      const offer = await createHub({ baseUrl: cfg.hub, key: cfg.key, log }).setNode(offerFromConfig(cfg, res))
      out({ enabled: offer.enabled, price_per_minute_usd: offer.price_per_minute_usd, mobility: offer.mobility, share: offer.share, windows: offer.windows, window_open_now: offer.window_open_now })
      if (!offer.enabled) out('the node is OFF until a price is set: versum-node offer --price=…'); return
    }
    case 'on': case 'off': {
      const cfg = loadConfig(home)
      if (!cfg.key) throw new Error('pair first')
      if (cmd === 'on' && cfg.price_per_minute_usd == null) throw new Error('set a price first: versum-node offer --price=0.02')
      const offer = await createHub({ baseUrl: cfg.hub, key: cfg.key, log }).setNode({ enabled: cmd === 'on' })
      out(`node is ${offer.enabled ? 'ON — taking jobs' : 'OFF — not taking jobs (your offer is kept)'}`); return
    }
    case 'status': {
      const cfg = loadConfig(home)
      if (!cfg.key) { out({ paired: false, config: redactConfig(cfg) }); return }
      const o = await createHub({ baseUrl: cfg.hub, key: cfg.key, log }).getNode()
      out({ enabled: o.enabled, online: o.presence?.online, window_open_now: o.window_open_now, price_per_minute_usd: o.price_per_minute_usd, share: o.share, reputation: o.reputation, earnings: o.earnings, last_scan: o.reported_at }); return
    }
    case 'start': case 'once': {
      const cfg = loadConfig(home)
      // stage 2: an unpaired node starts anyway and waits for the key on the local page (or VERSUM_NODE_KEY from the installer)
      await startNode({ home, cfg, log, once: cmd === 'once' }); return
    }
    case 'open': {
      const url = `http://127.0.0.1:${process.env.VERSUM_NODE_HEALTH_PORT ?? 3311}/`
      if (flag('wait') !== null) { for (let i = 0; i < 120; i++) { try { const r = await fetch(url + 'api/state', { signal: AbortSignal.timeout(2000) }); if (r.ok) break } catch {} await new Promise((r) => setTimeout(r, 500)) } }
      out(url)
      const { spawn } = await import('node:child_process')
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      try { spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch { /* no desktop here: the URL above is the answer */ }
      return
    }
    case 'run-local': {
      const file = rest.find((x) => !x.startsWith('--'))
      if (!file) throw new Error('usage: versum-node run-local <manifest.json>')
      const cfg = loadConfig(home); ensureHome(home)
      const rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true, appRoot: APP_ROOT })
      if (!rtd.ok) { for (const r of rtd.reasons) log(r); throw new Error('no usable runtime') }
      const exec = makeExecutor(rtd, { home, egressDir: join(APP_ROOT, 'egress'), log })
      await exec.ensureGrants()
      const manifest = validateManifest(readJsonFile(file))
      const raw = readJsonFile(file)
      manifest.inputs = manifest.inputs.map((f, i) => ({ ...f, path: raw.inputs?.[i]?.path }))
      const r = await runAttempt({ manifest, share: { ...cfg.share, allow_network: flag('network') === 'true' || cfg.share.allow_network }, exec, home, log, local: true })
      out(r); process.exitCode = r.outcome === 'succeeded' ? 0 : 1; return
    }
    case 'sandbox-check': {
      // The probe (probe/sandbox_probe.py) tries to reach the network, 127.0.0.1, the users directory and a path
      // outside its own directory, then writes out/result.json. Exit 0 only when every door was shut.
      const cfg = loadConfig(home); ensureHome(home)
      const rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true, appRoot: APP_ROOT })
      if (!rtd.ok) { for (const r of rtd.reasons) log(r); throw new Error('no usable runtime') }
      const exec = makeExecutor(rtd, { home, egressDir: join(APP_ROOT, 'egress'), log })
      await exec.ensureGrants()
      const probe = join(APP_ROOT, 'probe', 'sandbox_probe.py')
      const id = (globalThis.crypto ?? (await import('node:crypto')).webcrypto).randomUUID()
      const manifest = validateManifest({ attempt_id: id, piece_id: id, job_id: id, kind: 'python', image: 'ghcr.io/sudzikcoin/versum-python@sha256:' + 'f'.repeat(64), command: ['python', '/job/in/sandbox_probe.py'], env: {}, args: { probe: true }, limits: { cpu_cores: 1, ram_mb: 512, disk_mb: 256, gpu: false, network: false, time_limit_minutes: 2 }, inputs: [{ name: 'sandbox_probe.py', url: 'https://localhost/probe', size_bytes: 0 }], price_per_minute_usd: 0 })
      manifest.inputs[0].path = probe
      const r = await runAttempt({ manifest, share: cfg.share, exec, home, log, local: true })
      let result = null
      try { result = JSON.parse((await import('node:fs')).readFileSync(join(r.job_dir, 'out', 'result.json'), 'utf8')) } catch {}
      const v = probeVerdict(result)
      out({ runtime: describeRuntime(rtd), outcome: r.outcome, exit_code: r.exit_code, result, sandbox_ok: v.ok, failures: v.failures, stderr_tail: r.stderr_tail })
      try { (await import('node:fs')).rmSync(r.job_dir, { recursive: true, force: true }) } catch {}
      process.exitCode = r.outcome === 'succeeded' && v.ok ? 0 : 1; return
    }
    case 'gpu-check': {
      // 0.4.4: the GPU probe by hand — the same two runs the node does on first start (lib/gpu-probe.mjs), never from the cache.
      // --force runs the probe even without an NVIDIA GPU (what CI does: the sandboxed interpreter must still write its result).
      const cfg = loadConfig(home); ensureHome(home)
      const rtd = await detectRuntime(cfg.runtime, { allowRootful: cfg.allow_rootful === true, appRoot: APP_ROOT })
      if (!rtd.ok) { for (const r of rtd.reasons) log(r); throw new Error('no usable runtime') }
      if (rtd.kind !== 'native') throw new Error('gpu-check is for the built-in sandbox (Windows / macOS); a container node uses the nvidia container toolkit')
      const { runGpuProbe } = await import('../lib/gpu-probe.mjs')
      const { PYLIB_GPU_DIR, MARKER } = await import('../lib/pylib-gpu.mjs')
      const res = await scan({ jobsDir: jobsDir(home), runtime: rtd })
      let gpu = res.gpu
      out(`gpu      ${gpu?.model ? `${gpu.model} · ${gpu.vram_mb ?? '?'} MB · CUDA ${gpu.cuda ?? 'none'} · driver ${gpu.driver ?? '?'}` : 'none'}`)
      if (has('force') && !gpu?.cuda) gpu = { ...gpu, vendor: 'nvidia', model: gpu?.model ?? '(no GPU — forced run)', cuda: gpu?.cuda ?? '0.0' }
      const exec = makeExecutor(rtd, { home, egressDir: join(APP_ROOT, 'egress'), log })
      await exec.ensureGrants()
      // the torch stage when the GPU set is already unpacked here (the marker lib/pylib-gpu.mjs writes), the driver stage otherwise
      const gpuDir = join(stateDir(home), PYLIB_GPU_DIR)
      let stamp = null; try { stamp = JSON.parse(readFileSync(join(gpuDir, MARKER), 'utf8')).stamp } catch {}
      const stage = stamp ? 'torch' : 'driver'
      const pylibDir = join(stateDir(home), 'pylib')
      const r = await runGpuProbe({ home, appRoot: APP_ROOT, stateDir: stateDir(home), gpu, stage, exec, pythonExe: rtd.python.exe, pythonDir: rtd.python.dir, pylibDir: existsSync(pylibDir) ? pylibDir : null, gpuDir: stamp ? gpuDir : null, stamp, log, force: true, nodeVersion: NODE_VERSION })
      out({ stage: r.stage, verdict: r.verdict, detail: r.detail, sandbox_exit: r.sandbox_exit ?? null, bare: r.bare && Object.fromEntries(['nvcuda', 'torch', 'cupy', 'numba'].map((k) => [k, r.bare[k] ? { ok: r.bare[k].ok, error: r.bare[k].error ?? null } : null])), sandboxed: r.sandboxed && Object.fromEntries(['nvcuda', 'torch', 'cupy', 'numba'].map((k) => [k, r.sandboxed[k] ? { ok: r.sandboxed[k].ok, error: r.sandboxed[k].error ?? null } : null])), report: join(stateDir(home), 'gpu-probe.json') })
      if (has('force') && !r.sandboxed) { out('FAIL: the sandboxed interpreter wrote no result — the probe did not run inside the sandbox at all'); process.exitCode = 1; return }
      process.exitCode = r.verdict === 'appcontainer_ok' ? 0 : r.verdict === 'no_gpu' ? 2 : 1; return
    }
    case 'prune': {
      const c1 = loadConfig(home)
      const rtd = await detectRuntime(c1.runtime, { allowRootful: c1.allow_rootful === true, appRoot: APP_ROOT })
      if (!rtd.rt) { out('nothing to prune: this node runs jobs in the built-in sandbox, there are no containers or images'); return }
      const n = await reapContainers(rtd.rt, log)
      const pruned = await rtd.rt.run(['image', 'prune', '-f']).catch((e) => e.message)
      out(`containers removed: ${n}\n${pruned}`); return
    }
    case 'version': out(`versum-node ${NODE_VERSION}`); return
    default:
      out(`versum-node — share your computer's spare compute by the minute

  scan · doctor · pair <key> · offer [--cpu= --ram-gb= --disk-gb= --gpu= --parallel= --max-job-minutes= --network= --price= --mobility= --windows=]
  on · off · status · start · once · open · run-local <manifest.json> · sandbox-check · gpu-check · prune · version

After install nothing here is needed: the local page http://127.0.0.1:3311/ pairs, sets the share and the price, pauses, shows earnings and the log.

Config: ${join(home, 'config.json')} (mode 600). Jobs run under ${jobsDir(home)} and are wiped.`)
      process.exitCode = cmd ? 1 : 0
  }
}
main().catch((e) => { process.stderr.write(`versum-node: ${e.code ? e.code + ' ' : ''}${e.message}\n`); process.exit(1) })
