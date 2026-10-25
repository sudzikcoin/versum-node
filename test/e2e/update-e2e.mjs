#!/usr/bin/env node
/**
 * The self-update, end to end, on the release runners after hub-e2e.mjs: the node installed from THIS run's
 * installer (the tag's version) must update itself to a release-candidate bundle built in the same run.
 *
 *   1. the local page says which version runs and that it is paired; the hub says which executor this key is
 *   2. the rc bundle (VERSUM_E2E_RC_BUNDLE, version VERSUM_E2E_RC_VERSION) is served from 127.0.0.1:3399 by this script
 *   3. the hub's e2e door pins a release override for this executor: {version, assets: {<platform>: {url, sha256, size}}}
 *   4. the node's next heartbeat brings the override; the page shows "updating to v…", the process swaps and restarts
 *   5. the page comes back with the rc version; the key, hub, name and price are the ones from before; python packages
 *      report ok again; the hub's node_resources carry the rc version and the heartbeat app string says it too
 *   6. the override is cleared (always — also on failure)
 *
 * Env: VERSUM_E2E_HUB, VERSUM_E2E_SECRET, VERSUM_E2E_NODE_KEY (the installed node's key), VERSUM_E2E_RC_BUNDLE,
 *      VERSUM_E2E_RC_VERSION (e.g. 0.4.4-rc.123), VERSUM_E2E_PLATFORM (win32-x64 | darwin-arm64 | darwin-x64).
 */
import { createServer } from 'node:http'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

const HUB = (process.env.VERSUM_E2E_HUB ?? 'https://api.suverse.io/launchloop-dev').replace(/\/$/, '')
const SECRET = process.env.VERSUM_E2E_SECRET ?? ''
const KEY = process.env.VERSUM_E2E_NODE_KEY ?? ''
const BUNDLE = process.env.VERSUM_E2E_RC_BUNDLE ?? ''
const RC = String(process.env.VERSUM_E2E_RC_VERSION ?? '').replace(/^v/, '')
const PLATFORM = process.env.VERSUM_E2E_PLATFORM ?? ''
const LOCAL = 'http://127.0.0.1:3311'
const PORT = 3399
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (m) => console.log(`[update-e2e ${new Date().toISOString().slice(11, 19)}] ${m}`)
const door = (method, body, q = '') => fetch(`${HUB}/test/e2e-release${q}`, { method, headers: { 'content-type': 'application/json', 'x-test-proof-secret': SECRET }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
let executorId = null
const clearOverride = async () => { if (executorId) await door('POST', { executor_id: executorId, clear: true }).catch(() => null) }
const fail = async (m) => { console.error(`[update-e2e] FAIL: ${m}`); try { console.error('--- node log tail ---'); console.error((await (await fetch(`${LOCAL}/api/log`)).text()).split('\n').slice(-60).join('\n')) } catch {} await clearOverride(); process.exit(1) }
const localState = async () => { const r = await fetch(`${LOCAL}/api/state`, { signal: AbortSignal.timeout(3000) }); return r.json() }
async function waitFor(label, fn, { timeoutMs = 120_000, everyMs = 2000 } = {}) {
  const t0 = Date.now(); let lastErr = null
  for (;;) {
    try { const v = await fn(); if (v) return v } catch (e) { lastErr = e }
    if (Date.now() - t0 > timeoutMs) await fail(`${label}: timed out after ${Math.round(timeoutMs / 1000)} s${lastErr ? ` (last error: ${lastErr.message})` : ''}`)
    await sleep(everyMs)
  }
}

async function main() {
  if (!SECRET || !KEY || !BUNDLE || !RC || !PLATFORM) await fail('VERSUM_E2E_SECRET, VERSUM_E2E_NODE_KEY, VERSUM_E2E_RC_BUNDLE, VERSUM_E2E_RC_VERSION and VERSUM_E2E_PLATFORM are required')
  // 1 — before
  const before = await waitFor('local page paired', async () => { const s = await localState(); return s.paired ? s : null })
  say(`running versum-node ${before.version} · paired with ${before.hub} · name "${before.name}" · price ${before.price_per_minute_usd}`)
  if (before.version === RC) await fail(`the node already runs ${RC}; nothing to update`)
  const me = await (await fetch(`${HUB}/api/agent/v1/me`, { headers: { authorization: `Bearer ${KEY}` } })).json()
  executorId = me?.executor?.id ?? null
  if (!executorId) await fail(`the hub did not say which executor this key is: ${JSON.stringify(me).slice(0, 200)}`)
  say(`executor ${executorId}`)
  // 2 — serve the rc bundle on loopback
  const size = statSync(BUNDLE).size, sha256 = createHash('sha256').update(readFileSync(BUNDLE)).digest('hex')
  const server = createServer((req, res) => { if (req.url !== '/rc.tar.gz') { res.writeHead(404); res.end(); return } res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(size) }); createReadStream(BUNDLE).pipe(res) })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  say(`serving the rc bundle (${Math.round(size / 1048576)} MB, sha256 ${sha256.slice(0, 12)}…) as v${RC} on 127.0.0.1:${PORT}`)
  // 3 — the override on the hub
  const set = await door('POST', { executor_id: executorId, version: RC, assets: { [PLATFORM]: { url: `http://127.0.0.1:${PORT}/rc.tar.gz`, sha256, size } } })
  if (set.status !== 200 || !set.json?.ok) await fail(`override not accepted: ${set.status} ${JSON.stringify(set.json)}`)
  say('release override set on the hub')
  // 4 — the node notices, downloads, swaps, restarts
  const seen = new Set()
  await waitFor('the node notices the release', async () => { const s = await localState(); const st = s.update?.status; if (st && !seen.has(st)) { seen.add(st); say(`page: ${s.update.line ?? st}`) } return ['downloading', 'unpacking', 'ready', 'applying'].includes(st) || s.version === RC ? s : null }, { timeoutMs: 120_000, everyMs: 1000 })
  const after = await waitFor(`the node comes back as ${RC}`, async () => { let s = null; try { s = await localState() } catch { return null } if (s.update?.status && !seen.has(s.update.status)) { seen.add(s.update.status); say(`page: ${s.update.line ?? s.update.status}`) } if (s.update?.status === 'failed' || s.update?.status === 'rolled_back') throw new Error(s.update.line); return s.version === RC && s.paired ? s : null }, { timeoutMs: 420_000, everyMs: 2000 })
  say(`back as versum-node ${after.version} · update ${after.update?.status}: ${after.update?.line}`)
  // 5 — what must have survived, and what must say the new version
  if (after.hub !== before.hub) await fail(`the hub changed: ${before.hub} → ${after.hub}`)
  if (after.name !== before.name) await fail(`the name changed: ${before.name} → ${after.name}`)
  if (after.price_per_minute_usd !== before.price_per_minute_usd) await fail(`the price changed: ${before.price_per_minute_usd} → ${after.price_per_minute_usd}`)
  if (JSON.stringify(after.share) !== JSON.stringify(before.share)) await fail(`the share changed: ${JSON.stringify(before.share)} → ${JSON.stringify(after.share)}`)
  const settled = await waitFor('first heartbeat after the update settles the swap', async () => { const s = await localState(); return s.presence?.last_heartbeat_ok && s.update?.status === 'done' ? s : null }, { timeoutMs: 120_000 })
  say(`heartbeat ok at ${settled.presence.last_heartbeat_at} · ${settled.update.line}`)
  const py = await waitFor('python packages report ok again', async () => { const s = await localState(); if (s.pylib?.status === 'failed') throw new Error(s.pylib.line); return s.pylib?.status === 'ok' ? s : null }, { timeoutMs: 300_000, everyMs: 3000 })
  say(py.pylib.line)
  // 0.4.4: the sandbox GPU probe ran on first start and the hub heard its verdict — no_gpu on a runner without an NVIDIA driver
  const hubView = await waitFor('the hub records the new version', async () => { const r = await door('GET', null, `?executor_id=${executorId}`); return r.json?.node_version === RC && r.json?.app === `versum-node/${RC}` && r.json?.python_packages === 'ok' && r.json?.gpu_probe === 'no_gpu' ? r.json : null }, { timeoutMs: 180_000, everyMs: 3000 })
  say(`hub: node_version ${hubView.node_version} · app ${hubView.app} · python_packages ${hubView.python_packages} · gpu_probe ${hubView.gpu_probe} · last seen ${hubView.last_seen_at}`)
  // 6 — done
  await clearOverride()
  server.close()
  console.log(JSON.stringify({ ok: true, from: before.version, to: after.version, executor_id: executorId, platform: PLATFORM, update: settled.update }, null, 2))
  process.exit(0)
}
main().catch((e) => fail(e.stack ?? e.message))
