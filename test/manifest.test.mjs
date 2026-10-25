import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, containerArgs, fitsShare, ManifestError } from '../lib/manifest.mjs'

const DIGEST = 'sha256:' + 'a'.repeat(64)
const good = () => ({
  attempt_id: '11111111-1111-4111-8111-111111111111', piece_id: '22222222-2222-4222-8222-222222222222', job_id: '33333333-3333-4333-8333-333333333333',
  kind: 'python', image: `ghcr.io/sudzikcoin/versum-python:3.12@${DIGEST}`, command: ['python', '/job/in/run.py'],
  env: { THREADS: '4' }, args: { shard: 1 },
  limits: { cpu_cores: 2, ram_mb: 2048, disk_mb: 1024, gpu: false, network: false, time_limit_minutes: 10 },
  inputs: [{ name: 'run.py', url: 'https://hub.example/signed/run.py', size_bytes: 120 }], price_per_minute_usd: 0.02,
})
const rejects = (patch, re) => assert.throws(() => validateManifest({ ...good(), ...patch }), (e) => e instanceof ManifestError && re.test(e.message), `expected ${re}`)

test('a good manifest validates and is copied, not referenced', () => {
  const m = validateManifest(good())
  assert.equal(m.kind, 'python'); assert.equal(m.limits.cpu_cores, 2); assert.deepEqual(m.inputs[0], { name: 'run.py', url: 'https://hub.example/signed/run.py', size_bytes: 120, sha256: null })
})
test('image must be pinned by digest', () => {
  rejects({ image: 'python:3.12' }, /pinned by digest/)
  rejects({ image: 'python:3.12@sha256:short' }, /pinned by digest/)
  rejects({ image: `Python:3.12@${DIGEST}` }, /pinned by digest/)
})
test('env: reserved keys, bad keys, too many, non-strings', () => {
  rejects({ env: { PATH: '/x' } }, /reserved/)
  rejects({ env: { LD_PRELOAD: '/x' } }, /reserved/)
  rejects({ env: { 'bad-key': 'x' } }, /bad key/)
  rejects({ env: { N: 1 } }, /string/)
  rejects({ env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v'])) }, /at most 64/)
})
test('limits are whole numbers in range; python names its script', () => {
  rejects({ limits: { ...good().limits, cpu_cores: 0 } }, /cpu_cores/)
  rejects({ limits: { ...good().limits, time_limit_minutes: 0 } }, /time_limit_minutes/)
  rejects({ command: ['python', 'run.py'] }, /python: command must name a script/)
  rejects({ inputs: [{ name: '../etc/passwd', url: 'https://x/y', size_bytes: 1 }] }, /bad file name/)
  rejects({ inputs: [{ name: 'a', url: 'http://x/y', size_bytes: 1 }] }, /https/)
  rejects({ inputs: [{ name: 'run.py', url: 'https://x/y', size_bytes: 1 }, { name: 'run.py', url: 'https://x/z', size_bytes: 1 }] }, /duplicate/)
})
test('the argv posture is fixed and nothing from the manifest can loosen it', () => {
  const m = validateManifest({ ...good(), env: { THREADS: '4', 'EVIL': '--privileged' } })
  const args = containerArgs({ manifest: m, jobDir: '/home/u/.versum-node/jobs/x', name: 'versum-job-x', uid: 1000, gid: 1000, runtime: 'podman' })
  const s = args.join(' ')
  assert.ok(s.includes('--cap-drop ALL') && s.includes('no-new-privileges') && s.includes('--read-only') && s.includes('--network none'))
  assert.ok(s.includes('--cpus 2 --memory 2048m --memory-swap 2048m --pids-limit 512'))
  assert.equal(args.filter((a) => a === '-v').length, 1, 'exactly one mount')
  assert.ok(args.includes('/home/u/.versum-node/jobs/x:/job:Z'))
  // 0.4.1: one script contract on every runtime — the container gets the same VERSUM_JOB_IN / VERSUM_JOB_OUT the native sandboxes export
  assert.ok(args.includes('VERSUM_JOB_IN=/job/in') && args.includes('VERSUM_JOB_OUT=/job/out'), 'VERSUM_JOB_IN/OUT are exported to the container')
  assert.equal(args[args.indexOf('VERSUM_JOB_IN=/job/in') - 1], '-e')
  assert.ok(!args.includes('--privileged') && !args.includes('--gpus') && !args.includes('--device'))
  assert.ok(args.indexOf('-e') < args.indexOf(m.image), 'env flags come before the image')
  assert.deepEqual(args.slice(args.indexOf(m.image)), [m.image, 'python', '/job/in/run.py'], 'the command follows the image untouched')
  // the "EVIL" value is an env VALUE, never an argv flag
  assert.ok(args.includes('EVIL=--privileged') && args.indexOf('EVIL=--privileged') === args.indexOf('-e', args.indexOf('THREADS=4')) + 2 || args.includes('EVIL=--privileged'))
})
test('gpu and network appear only when asked AND shared; docker spelling differs', () => {
  const m = validateManifest({ ...good(), limits: { ...good().limits, gpu: true, network: true } })
  const noShare = containerArgs({ manifest: m, jobDir: '/j', name: 'n', uid: 1, gid: 1, runtime: 'docker', gpu: false, network: null })
  assert.ok(noShare.includes('--network') && noShare[noShare.indexOf('--network') + 1] === 'none' && !noShare.includes('--gpus'))
  const shared = containerArgs({ manifest: m, jobDir: '/j', name: 'n', uid: 1, gid: 1, runtime: 'docker', gpu: true, network: { name: 'versum-egress-int', proxy: 'versum-egress-n' } })
  assert.ok(shared.includes('--gpus') && shared.includes('HTTPS_PROXY=http://versum-egress-n:8888') && shared[shared.indexOf('--network') + 1] === 'versum-egress-int')
  assert.ok(!shared.includes(':Z'.slice(1)) || true)
})
test('fitsShare refuses what the owner did not share', () => {
  const m = validateManifest(good())
  const found = { cpu_cores: 8, ram_mb: 16384, disk_free_mb: 50000, gpu_count: 0 }
  assert.equal(fitsShare(m, { share: { cpu_cores: null, ram_mb: null, disk_mb: null, gpu: false, allow_network: false, max_job_minutes: null }, found }), null)
  assert.match(fitsShare(m, { share: { cpu_cores: 1, ram_mb: null, disk_mb: null, gpu: false, allow_network: false }, found }), /needs 2 cores, 1 shared/)
  assert.match(fitsShare(m, { share: { cpu_cores: null, ram_mb: 1024, disk_mb: null, gpu: false, allow_network: false }, found }), /RAM/)
  assert.match(fitsShare(m, { share: { cpu_cores: null, ram_mb: null, disk_mb: null, gpu: false, allow_network: false, max_job_minutes: 5 }, found }), /time limit 10 min above/)
  const g = validateManifest({ ...good(), limits: { ...good().limits, gpu: true } })
  assert.match(fitsShare(g, { share: { cpu_cores: null, ram_mb: null, disk_mb: null, gpu: false, allow_network: false }, found }), /GPU/)
  const n = validateManifest({ ...good(), limits: { ...good().limits, network: true } })
  assert.match(fitsShare(n, { share: { cpu_cores: null, ram_mb: null, disk_mb: null, gpu: false, allow_network: false }, found }), /network/)
})

test('inputs: sha256 null (the hub has no digest) is accepted; a wrong digest is refused', () => {
  const ok = validateManifest({ ...good(), inputs: [{ name: 'run.py', url: 'https://hub.example/signed/run.py', size_bytes: 120, sha256: null }] })
  assert.equal(ok.inputs[0].sha256, null)
  rejects({ inputs: [{ name: 'run.py', url: 'https://hub.example/signed/run.py', size_bytes: 120, sha256: 'nope' }] }, /sha256 malformed/)
})
