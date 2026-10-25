#!/usr/bin/env node
/**
 * The end-to-end check the release runners perform after installing the node from the real installer
 * (Windows .exe on windows-latest, macOS .dmg on macos-latest), with nothing but the node itself on the box:
 *
 *   1. the local page answers and the node is PAIRED (the key came from the installer's file name)
 *   2. the scan says executor_kind script_native and the runtime is the built-in sandbox
 *   3. the offer is set from the page's own API (price, one job at once) → the hub shows the node enabled
 *   4. a python job is created and funded on the hub through the e2e door (the sandbox probe as the script),
 *      priced so that only this node fits (cap = price × minutes), as a buyer who is not the node's owner
 *   5. the node leases it, runs it inside the sandbox, uploads out/result.json, the job completes
 *   6. result.json says every door was shut (network, loopback, the users directory, writes outside the job)
 *
 * Env: VERSUM_E2E_HUB (https://api.suverse.io/launchloop-dev), VERSUM_E2E_SECRET (x-test-proof-secret),
 *      VERSUM_E2E_BUYER (an +ll-e2e- email that is NOT the node's owner), VERSUM_E2E_PRICE (default 0.0001).
 * Exit 0 only when everything above held. Prints every step; the node's log tail on failure.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB = (process.env.VERSUM_E2E_HUB ?? 'https://api.suverse.io/launchloop-dev').replace(/\/$/, '')
const SECRET = process.env.VERSUM_E2E_SECRET ?? ''
const BUYER = process.env.VERSUM_E2E_BUYER ?? ''
const PRICE = Number(process.env.VERSUM_E2E_PRICE ?? '0.0001')
const LOCAL = 'http://127.0.0.1:3311'
const EXPECT = process.env.VERSUM_E2E_EXPECT_SANDBOX ?? ''   // appcontainer | seatbelt
const H = { 'content-type': 'application/json', 'x-versum-local': '1' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (m) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`)
const fail = async (m) => { console.error(`[e2e] FAIL: ${m}`); try { console.error('--- node log tail ---'); console.error((await (await fetch(`${LOCAL}/api/log`)).text()).split('\n').slice(-60).join('\n')) } catch {} process.exit(1) }

async function waitFor(label, fn, { timeoutMs = 120_000, everyMs = 2000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await fn(); if (v) return v } catch (e) { if (Date.now() - t0 > timeoutMs) await fail(`${label}: ${e.message}`) }
    if (Date.now() - t0 > timeoutMs) await fail(`${label}: timed out after ${Math.round(timeoutMs / 1000)} s`)
    await sleep(everyMs)
  }
}

async function main() {
  if (!SECRET || !BUYER) await fail('VERSUM_E2E_SECRET and VERSUM_E2E_BUYER are required')
  // 1 — the page, paired
  const state = await waitFor('local page paired', async () => { const r = await fetch(`${LOCAL}/api/state`); const s = await r.json(); return s.paired ? s : null })
  say(`paired · hub ${state.hub} · versum-node ${state.version} · runtime ${state.runtime?.description ?? state.runtime?.name}`)
  if (state.hub.replace(/\/$/, '') !== HUB) await fail(`the node pairs with ${state.hub}, expected ${HUB}`)
  // 2 — the runtime is the sandbox
  const ready = await waitFor('runtime + scan', async () => { const s = await (await fetch(`${LOCAL}/api/state`)).json(); return s.runtime?.ok && s.scan ? s : null })
  if (ready.runtime.kind !== 'native') await fail(`runtime kind ${ready.runtime.kind}, expected native: ${JSON.stringify(ready.runtime.reasons)}`)
  if (EXPECT && ready.runtime.sandbox !== EXPECT) await fail(`sandbox ${ready.runtime.sandbox}, expected ${EXPECT}`)
  if (ready.scan.executor_kind !== 'script_native') await fail(`scan.executor_kind = ${ready.scan.executor_kind}`)
  say(`sandbox ${ready.runtime.sandbox} · python ${ready.runtime.version} · ${ready.scan.cpu_cores} cores · ${ready.scan.ram_mb} MB · ${ready.scan.disk_free_mb} MB free`)
  // 3 — the offer
  const offer = await (await fetch(`${LOCAL}/api/offer`, { method: 'POST', headers: H, body: JSON.stringify({ share: { cpu_cores: 1, ram_mb: Math.min(2048, ready.scan.ram_mb ?? 2048), disk_mb: 2048, gpu: false, allow_network: false, max_parallel_jobs: 1, max_job_minutes: 60 }, price_per_minute_usd: PRICE, windows: 'always' }) })).json()
  if (!offer.saved || !offer.enabled) await fail(`offer not accepted: ${JSON.stringify(offer)}`)
  say(`offer saved · $${PRICE}/min · enabled`)
  const beat = await waitFor('first heartbeat', async () => { const s = await (await fetch(`${LOCAL}/api/state`)).json(); return s.presence?.last_heartbeat_ok ? s : null })
  say(`heartbeat ok at ${beat.presence.last_heartbeat_at}`)
  // 4 — the job on the hub
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'probe', 'sandbox_probe.py'), 'utf8')
  const minutes = 5
  const cap = Math.max(0.001, Math.round(PRICE * minutes * 1_000_000) / 1_000_000)
  const created = await (await fetch(`${HUB}/test/e2e-job`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-proof-secret': SECRET }, body: JSON.stringify({ buyer_email: BUYER, title: `native sandbox e2e ${process.platform} ${new Date().toISOString()}`, script_name: 'sandbox_probe.py', script, max_price_usd: cap, time_limit_minutes: minutes, req: { cpu_cores: 1, ram_mb: 512, disk_mb: 512 }, args: { platform: process.platform, run: process.env.GITHUB_RUN_ID ?? 'local' } }) })).json()
  if (!created.job_id) await fail(`job not created: ${JSON.stringify(created)}`)
  say(`job ${created.job_id} funded on the hub (cap $${cap}, ${minutes} min)`)
  // 5 — leased, run, completed
  const done = await waitFor('job completed', async () => {
    const j = await (await fetch(`${HUB}/test/e2e-job?id=${created.job_id}`, { headers: { 'x-test-proof-secret': SECRET } })).json()
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(`job ${j.status}: ${JSON.stringify(j.pieces?.[0]?.attempt)}`)
    return j.status === 'completed' ? j : null
  }, { timeoutMs: 240_000, everyMs: 5000 })
  const attempt = done.pieces[0].attempt
  say(`completed · node ${attempt.node_name} (${attempt.node_id}) · ${attempt.measured_minutes} min · $${attempt.billed_usd} · exit ${attempt.exit_code}`)
  const local = await (await fetch(`${LOCAL}/api/state`)).json()
  if (!local.finished?.some((f) => f.job_id === created.job_id && f.outcome === 'succeeded')) await fail(`this node did not run the job: ${JSON.stringify(local.finished)}`)
  // 6 — the probe's verdict
  const out = done.pieces[0].outputs.find((o) => o.name === 'result.json')
  if (!out) await fail(`no result.json among outputs: ${JSON.stringify(done.pieces[0].outputs)}`)
  const result = await (await fetch(out.url)).json()
  say(`probe: ${JSON.stringify(result)}`)
  const must = ['network_blocked', 'dns_blocked', 'loopback_blocked', 'users_dir_blocked', 'home_write_blocked', 'out_write_ok', 'temp_inside_ok', 'cwd', 'env_home_inside']
  const open = must.filter((k) => result[k] !== true)
  if (open.length) await fail(`the sandbox left these open: ${open.join(', ')}`)
  if (result.piece_args?.platform !== process.platform) await fail(`piece args did not arrive: ${JSON.stringify(result.piece_args)}`)
  say('every door shut: no network, no DNS, no loopback, no users directory, no writes outside the job; out/ written; temp and home inside the job')
  console.log(JSON.stringify({ ok: true, job_id: created.job_id, node_id: attempt.node_id, sandbox: ready.runtime.sandbox, python: ready.runtime.version, result }, null, 2))
}
main().catch((e) => fail(e.stack ?? e.message))
