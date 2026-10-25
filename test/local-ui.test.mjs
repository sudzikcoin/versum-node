import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeAllowed, clampShare, parsePrice, marketHint, windowsToText } from '../lib/local-ui.mjs'
import { bootstrapFromEnv, parseWindowsText } from '../lib/config.mjs'
import { offerFromConfig } from '../lib/node.mjs'

test('writes need the marker header and a same-origin (or absent) Origin', () => {
  assert.equal(writeAllowed({}, 3311), false)
  assert.equal(writeAllowed({ 'x-versum-local': '1' }, 3311), true)
  assert.equal(writeAllowed({ 'x-versum-local': '1', origin: 'http://127.0.0.1:3311' }, 3311), true)
  assert.equal(writeAllowed({ 'x-versum-local': '1', origin: 'http://localhost:3311' }, 3311), true)
  assert.equal(writeAllowed({ 'x-versum-local': '1', origin: 'https://evil.example' }, 3311), false)
  assert.equal(writeAllowed({ 'x-versum-local': '1', origin: 'http://127.0.0.1:3312' }, 3311), false)
})

test('the share is clamped to what the machine has; GPU only when one exists', () => {
  const found = { cpu_cores: 8, ram_mb: 16000, disk_free_mb: 100000, gpu_count: 0 }
  const s = clampShare({ cpu_cores: 99, ram_mb: 64000, disk_mb: 5000, gpu: true, max_parallel_jobs: 0, max_job_minutes: 'x', allow_network: 1 }, found)
  assert.deepEqual(s, { cpu_cores: 8, ram_mb: 16000, disk_mb: 5000, gpu: false, max_parallel_jobs: 1, max_job_minutes: 240, allow_network: true })
  assert.equal(clampShare({ gpu: true }, { ...found, gpu_count: 1 }).gpu, true)
  assert.equal(clampShare({ cpu_cores: 0 }, found).cpu_cores, null, 'zero means all of it')
  assert.equal(clampShare({ cpu_cores: 4 }, null).cpu_cores, 4, 'no scan yet: trust the number')
})

test('price: empty clears, out of range refused, six decimals kept', () => {
  assert.deepEqual(parsePrice(''), { price: null })
  assert.deepEqual(parsePrice('0.0200001'), { price: 0.02 })
  assert.deepEqual(parsePrice('0.123456789'), { price: 0.123457 })
  assert.ok(parsePrice('-1').error)
  assert.ok(parsePrice('abc').error)
})

test('market hint: cheapest and middle online price; empty board says so', () => {
  assert.deepEqual(marketHint(null), { online: 0, min: null, median: null })
  const m = marketHint({ nodes: [{ online: true, price_per_minute_usd: 0.05 }, { online: false, price_per_minute_usd: 0.001 }, { online: true, price_per_minute_usd: 0.02 }, { online: true, price_per_minute_usd: 0.03 }] })
  assert.deepEqual(m, { online: 3, min: 0.02, median: 0.03 })
})

test('windows round-trip through the text the page edits', () => {
  const w = parseWindowsText('Mon-Fri 22:00-07:00, Sat 00:00-24:00')
  const text = windowsToText(w)
  assert.deepEqual(parseWindowsText(text), w)
  assert.equal(windowsToText([]), '')
})

test('the installer environment pairs a fresh config once; a paired config is left alone', () => {
  const key = 'llk_' + 'a'.repeat(32)
  const a = bootstrapFromEnv({ key: null, hub: 'https://old' }, { VERSUM_NODE_KEY: key, VERSUM_HUB: 'https://hub.example/' })
  assert.equal(a.applied, true); assert.equal(a.cfg.key, key); assert.equal(a.cfg.hub, 'https://hub.example')
  assert.equal(bootstrapFromEnv({ key: 'llk_x', hub: 'h' }, { VERSUM_NODE_KEY: key }).applied, false)
  assert.equal(bootstrapFromEnv({ key: null, hub: 'h' }, { VERSUM_NODE_KEY: 'nope' }).applied, false)
})

test('paused → enabled false, the offer kept', () => {
  const cfg = { share: { cpu_cores: 2, ram_mb: 1024, disk_mb: 1024, gpu: false, max_parallel_jobs: 1, max_job_minutes: 60, allow_network: false }, price_per_minute_usd: 0.02, mobility: 'stationary', windows: [], timezone: 'UTC', paused: true }
  assert.equal(offerFromConfig(cfg).enabled, false)
  assert.equal(offerFromConfig({ ...cfg, paused: false }).enabled, true)
  assert.equal(offerFromConfig({ ...cfg, paused: false, price_per_minute_usd: null }).enabled, false)
})
