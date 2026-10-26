import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offerPatchFromArgs, parseWindowsText, saveConfig, loadConfig, DEFAULT_CONFIG, redactConfig, defaultShare, applyDefaultShare } from '../lib/config.mjs'
import { windowOpen, offerFromConfig } from '../lib/node.mjs'
import { createPulse } from '../lib/pulse.mjs'
import { createAdmission } from '../lib/admission.mjs'
import { outcomeOf } from '../lib/runner.mjs'

test('offer flags → config patch', () => {
  assert.deepEqual(offerPatchFromArgs(['--cpu=4', '--ram-gb=8', '--gpu=true', '--price=0.02', '--parallel=2', '--network=false', '--mobility=mobile']),
    { share: { cpu_cores: 4, ram_mb: 8192, gpu: true, max_parallel_jobs: 2, allow_network: false }, price_per_minute_usd: 0.02, mobility: 'mobile' })
  assert.deepEqual(offerPatchFromArgs(['--cpu=0']), { share: { cpu_cores: null } }, '0 = all')
  assert.deepEqual(offerPatchFromArgs(['--windows=always']), { windows: [] })
  assert.throws(() => offerPatchFromArgs(['--price=-1']), /USD per minute/)
  assert.throws(() => offerPatchFromArgs(['--parallel=40']), /1–32/)
  assert.throws(() => offerPatchFromArgs(['--bogus=1']), /unknown option/)
})
test('windows text: ranges, overnight split, every day', () => {
  assert.deepEqual(parseWindowsText('Sat 09:00-17:00'), [{ weekday: 6, start: 540, end: 1020 }])
  assert.deepEqual(parseWindowsText('Mon-Tue 22:00-07:00'), [
    { weekday: 1, start: 1320, end: 1440 }, { weekday: 2, start: 0, end: 420 },
    { weekday: 2, start: 1320, end: 1440 }, { weekday: 3, start: 0, end: 420 }])
  assert.deepEqual(parseWindowsText('00:00-24:00'), [{ weekday: null, start: 0, end: 1440 }])
  assert.deepEqual(parseWindowsText('Sun-Mon 10:00-11:00').map((w) => w.weekday), [0, 1])
  assert.deepEqual(parseWindowsText('Sat-Sun 10:00-11:00').map((w) => w.weekday), [6, 0], 'wraps the week')
  assert.throws(() => parseWindowsText('Mon 10:00-10:00'), /empty/)
  assert.throws(() => parseWindowsText('whenever'), /cannot read/)
})
test('config file is 0600 and refuses a loose one', () => {
  const home = mkdtempSync(join(tmpdir(), 'vn-'))
  try {
    const p = saveConfig({ ...DEFAULT_CONFIG, key: 'llk_' + 'x'.repeat(32), price_per_minute_usd: 0.01 }, home)
    assert.equal(statSync(p).mode & 0o777, 0o600)
    const c = loadConfig(home)
    assert.equal(c.price_per_minute_usd, 0.01); assert.equal(redactConfig(c).key, 'llk_xxxx…')
    assert.equal(loadConfig(mkdtempSync(join(tmpdir(), 'vn-empty-'))).key, null, 'no file → defaults')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
test('windowOpen mirrors the hub (Sunday 2026-10-25)', () => {
  const sun0000 = new Date('2026-10-25T00:00:30Z'), sunNoon = new Date('2026-10-25T12:00:00Z')
  assert.equal(windowOpen([], 'UTC', sunNoon), true)
  assert.equal(windowOpen([{ weekday: null, start: 0, end: 1 }], 'UTC', sun0000), true)
  assert.equal(windowOpen([{ weekday: null, start: 0, end: 1 }], 'UTC', sunNoon), false)
  assert.equal(windowOpen([{ weekday: 0, start: 0, end: 1440 }], 'UTC', sunNoon), true)
  assert.equal(windowOpen([{ weekday: 1, start: 0, end: 1440 }], 'UTC', sunNoon), false)
  assert.equal(windowOpen([{ weekday: null, start: 480, end: 600, timezone: 'Asia/Tokyo' }], 'UTC', sun0000), true, '09:00 JST')
})
test('offerFromConfig: enabled iff priced; windows carry their shape', () => {
  const cfg = { ...DEFAULT_CONFIG, share: { ...DEFAULT_CONFIG.share, cpu_cores: 2 }, windows: [{ weekday: 1, start: 60, end: 120 }], timezone: 'Europe/Berlin' }
  const o = offerFromConfig(cfg, { cpu_cores: 8 })
  assert.equal(o.enabled, false); assert.equal(o.share.cpu_cores, 2); assert.deepEqual(o.windows, [{ weekday: 1, start: 60, end: 120 }]); assert.equal(o.resources.cpu_cores, 8)
  assert.equal(offerFromConfig({ ...cfg, price_per_minute_usd: 0.05 }).enabled, true)
})
test('pulse: heartbeats on the interval, kills on stall, never both', async () => {
  const sent = [], stalls = []
  let progressAt = 0
  const p = createPulse({ intervalMs: 30_000, stallMs: 120_000, send: async (e) => sent.push(e), status: () => ({ progressAt, cpuSeconds: 1 }), onStall: async (w) => stalls.push(w) })
  await p.tick(0); await p.tick(10_000); assert.equal(sent.length, 0)
  await p.tick(30_000); assert.equal(sent.length, 1); assert.equal(sent[0].wall_seconds, 30)
  progressAt = 60_000; await p.tick(60_000); await p.tick(170_000); assert.equal(stalls.length, 0, 'progress at 60 s keeps it alive until 180 s')
  await p.tick(181_000); assert.equal(stalls.length, 1); assert.equal(p.stalled, true)
  await p.tick(300_000); assert.equal(stalls.length, 1, 'stall fires once')
})
test('admission gate', () => {
  const a = createAdmission({ limit: 1 })
  a.start('x'); assert.equal(a.canStart(), false); assert.throws(() => a.start('y'), /limit/); a.end('x'); assert.equal(a.canStart(), true)
  a.limit = 99; assert.equal(a.limit, 32)
})
test('outcome words', () => {
  assert.equal(outcomeOf({ exitCode: 0, timedOut: false, stalled: false }), 'succeeded')
  assert.equal(outcomeOf({ exitCode: 1, timedOut: false, stalled: false }), 'failed')
  assert.equal(outcomeOf({ exitCode: 137, timedOut: true, stalled: false }), 'timeout')
  assert.equal(outcomeOf({ exitCode: 137, timedOut: false, stalled: true }), 'failed')
})

test('0.4.6: a fresh node shares half the machine — half the cores, half the RAM, min(1 GB, half the free disk), one job at a time', () => {
  assert.deepEqual(defaultShare({ cpu_cores: 8, ram_mb: 16384, disk_free_mb: 120000 }), { cpu_cores: 4, ram_mb: 8192, disk_mb: 1024, max_parallel_jobs: 1 })
  assert.deepEqual(defaultShare({ cpu_cores: 1, ram_mb: 900, disk_free_mb: 1500 }), { cpu_cores: 1, ram_mb: 512, disk_mb: 750, max_parallel_jobs: 1 }, 'floors: 1 core, 512 MB; disk = half of 1.5 GB')
  assert.deepEqual(defaultShare({ cpu_cores: 3, ram_mb: 7800, disk_free_mb: 300 }), { cpu_cores: 1, ram_mb: 3900, disk_mb: 256, max_parallel_jobs: 1 }, 'odd cores floor; disk never below 256 MB')
  assert.deepEqual(defaultShare(null), { cpu_cores: null, ram_mb: null, disk_mb: null, max_parallel_jobs: 1 }, 'no scan → nothing decided')
  const fresh = { ...DEFAULT_CONFIG, share: { ...DEFAULT_CONFIG.share } }
  const a = applyDefaultShare(fresh, { cpu_cores: 8, ram_mb: 16384, disk_free_mb: 120000 })
  assert.equal(a.changed, true); assert.equal(a.cfg.share_defaulted, true); assert.deepEqual([a.cfg.share.cpu_cores, a.cfg.share.ram_mb, a.cfg.share.disk_mb, a.cfg.share.max_parallel_jobs], [4, 8192, 1024, 1])
  assert.equal(applyDefaultShare(a.cfg, { cpu_cores: 2, ram_mb: 1024, disk_free_mb: 1 }).changed, false, 'never redone')
  const owner = applyDefaultShare({ ...fresh, share: { ...fresh.share, cpu_cores: 7 } }, { cpu_cores: 8, ram_mb: 16384, disk_free_mb: 120000 })
  assert.equal(owner.cfg.share.cpu_cores, 7, 'a dimension the owner set stays'); assert.equal(owner.cfg.share.ram_mb, 8192)
  const partial = applyDefaultShare(fresh, { cpu_cores: 8 })
  assert.equal(partial.cfg.share_defaulted, false, 'an incomplete scan leaves the flag off so the next scan finishes the job'); assert.equal(partial.cfg.share.cpu_cores, 4); assert.equal(partial.cfg.share.ram_mb, null)
  const all = applyDefaultShare({ ...fresh, share_defaulted: true }, { cpu_cores: 8, ram_mb: 16384, disk_free_mb: 120000 })
  assert.equal(all.changed, false, 'after --cpu=0 (all of it) nothing is re-defaulted')
})
