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
 *   versum-node start                      run the node (the systemd unit calls this)
 *   versum-node once                       one heartbeat, at most one job, exit
 *   versum-node run-local <manifest.json>  run a manifest without the hub (inputs by `path`); outputs stay in jobs/<id>/out
 *   versum-node prune                      remove leftover job containers and unused images
 */
import { join } from 'node:path'
import { loadConfig, saveConfig, redactConfig, ensureHome, nodeHome, jobsDir, offerPatchFromArgs, DEFAULT_HUB } from '../lib/config.mjs'
import { detectRuntime, reapContainers } from '../lib/runtime.mjs'
import { scan, renderScan } from '../lib/scan.mjs'
import { createHub } from '../lib/hub.mjs'
import { validateManifest } from '../lib/manifest.mjs'
import { runAttempt } from '../lib/runner.mjs'
import { startNode, offerFromConfig, readJsonFile, APP_ROOT } from '../lib/node.mjs'
import { log } from '../lib/log.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name) => { const a = rest.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null }
const home = nodeHome()
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o, null, 2)) + '\n')

async function main() {
  switch (cmd) {
    case 'scan': {
      const rtd = await detectRuntime(loadConfig(home).runtime).catch(() => null)
      const r = await scan({ jobsDir: jobsDir(ensureHome(home)), runtime: rtd?.name ? rtd : null })
      out(flag('json') !== null ? r : renderScan(r)); return
    }
    case 'doctor': {
      const cfg = loadConfig(home)
      const rtd = await detectRuntime(cfg.runtime)
      out(`runtime  ${rtd.name ? `${rtd.name} ${rtd.version} ${rtd.rootless ? 'rootless ✓' : 'ROOTFUL ✗'}` : 'none ✗'}`)
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
      const rtd = await detectRuntime(cfg.runtime)
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
      if (!cfg.key) throw new Error('not paired: versum-node pair <key>')
      await startNode({ home, cfg, log, once: cmd === 'once' }); return
    }
    case 'run-local': {
      const file = rest.find((x) => !x.startsWith('--'))
      if (!file) throw new Error('usage: versum-node run-local <manifest.json>')
      const cfg = loadConfig(home); ensureHome(home)
      const rtd = await detectRuntime(cfg.runtime)
      if (!rtd.ok) { for (const r of rtd.reasons) log(r); throw new Error('no usable runtime') }
      const manifest = validateManifest(readJsonFile(file))
      const raw = readJsonFile(file)
      manifest.inputs = manifest.inputs.map((f, i) => ({ ...f, path: raw.inputs?.[i]?.path }))
      const r = await runAttempt({ manifest, share: { ...cfg.share, allow_network: flag('network') === 'true' || cfg.share.allow_network }, rt: rtd.rt, runtime: rtd.name, home, egressDir: join(APP_ROOT, 'egress'), log, local: true })
      out(r); process.exitCode = r.outcome === 'succeeded' ? 0 : 1; return
    }
    case 'prune': {
      const rtd = await detectRuntime(loadConfig(home).runtime)
      if (!rtd.rt) throw new Error('no runtime')
      const n = await reapContainers(rtd.rt, log)
      const pruned = await rtd.rt.run(['image', 'prune', '-f']).catch((e) => e.message)
      out(`containers removed: ${n}\n${pruned}`); return
    }
    case 'version': out('versum-node 0.1.0'); return
    default:
      out(`versum-node — share your computer's spare compute by the minute

  scan · doctor · pair <key> · offer [--cpu= --ram-gb= --disk-gb= --gpu= --parallel= --max-job-minutes= --network= --price= --mobility= --windows=]
  on · off · status · start · once · run-local <manifest.json> · prune · version

Config: ${join(home, 'config.json')} (mode 600). Jobs run under ${jobsDir(home)} and are wiped.`)
      process.exitCode = cmd ? 1 : 0
  }
}
main().catch((e) => { process.stderr.write(`versum-node: ${e.code ? e.code + ' ' : ''}${e.message}\n`); process.exit(1) })
