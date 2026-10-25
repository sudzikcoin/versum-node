// The native sandbox (lib/native.mjs): the pure parts on any platform, and the executor's plumbing through the
// runner with the system Python and NO sandbox (the test-only `sandbox: 'none'`), so what the Windows and macOS
// runners test end to end is the sandbox alone, not the plumbing around it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { fitsNative, mapJobPath, nativeCommand, nativeEnv, sandboxProfile, cpuTimeToSeconds, parsePs, probeVerdict, dirSizeBytes, createNativeExecutor, findPython, detectNative } from '../lib/native.mjs'
import { runtimeOrder, makeExecutor } from '../lib/runtime.mjs'
import { runAttempt } from '../lib/runner.mjs'
import { validateManifest } from '../lib/manifest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = () => validateManifest({
  attempt_id: '11111111-1111-4111-8111-111111111111', piece_id: '22222222-2222-4222-8222-222222222222', job_id: '33333333-3333-4333-8333-333333333333',
  kind: 'python', image: 'ghcr.io/sudzikcoin/versum-python@sha256:' + 'a'.repeat(64), command: ['python', '/job/in/main.py', '--out', '/job/out', 'plain'],
  env: { THREADS: '2', TEMP: 'C:\\evil' }, args: { shard: 1 }, limits: { cpu_cores: 2, ram_mb: 1024, disk_mb: 512, gpu: false, network: false, time_limit_minutes: 5 },
  inputs: [{ name: 'main.py', url: 'https://x/y', size_bytes: 10 }], price_per_minute_usd: 0.01,
})

test('a native node runs python only, without GPU or network', () => {
  assert.equal(fitsNative(manifest()), null)
  assert.match(fitsNative({ ...manifest(), kind: 'container' }), /python scripts only/)
  assert.match(fitsNative({ ...manifest(), limits: { ...manifest().limits, gpu: true } }), /GPU/)
  assert.match(fitsNative({ ...manifest(), limits: { ...manifest().limits, network: true } }), /network/)
  assert.match(fitsNative({ ...manifest(), command: ['sh', '-c', 'x'] }), /must start with python/)
})

test('/job paths map into the attempt directory; dot-dot and other args stay as they are', () => {
  const d = process.platform === 'win32' ? 'C:\\jobs\\a' : '/home/u/.versum-node/jobs/a'
  assert.equal(mapJobPath('/job', d), d)
  assert.equal(mapJobPath('/job/in/main.py', d), join(d, 'in', 'main.py'))
  assert.equal(mapJobPath('/job/../etc', d), '/job/../etc')
  assert.equal(mapJobPath('--out', d), '--out')
  const argv = nativeCommand(manifest(), { jobDir: d, python: '/py/bin/python3' })
  assert.deepEqual(argv, ['/py/bin/python3', '-s', '-B', '-u', '-X', 'utf8', join(d, 'in', 'main.py'), '--out', join(d, 'out'), 'plain'])
})

test('the environment is ours: temp and home inside the job, buyer keys kept, buyer cannot override the base', () => {
  const win = nativeEnv(manifest(), { jobDir: 'C:\\jobs\\a', pythonDir: 'C:\\app\\python', platform: 'win32', hostEnv: { SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', PATH: 'C:\\lots' } })
  assert.equal(win.TEMP, 'C:\\jobs\\a\\tmp'); assert.equal(win.USERPROFILE, 'C:\\jobs\\a\\tmp'); assert.equal(win.PATH, 'C:\\app\\python'); assert.equal(win.THREADS, '2')
  assert.equal(win.VERSUM_JOB_DIR, 'C:\\jobs\\a'); assert.equal(win.NUMBER_OF_PROCESSORS, '2'); assert.equal(win.PYTHONNOUSERSITE, '1')
  const mac = nativeEnv(manifest(), { jobDir: '/Users/u/.versum-node/jobs/a', pythonDir: '/Users/u/.versum-node/app/python', platform: 'darwin', hostEnv: { HOME: '/Users/u' } })
  assert.equal(mac.HOME, '/Users/u/.versum-node/jobs/a/tmp'); assert.equal(mac.TMPDIR, mac.HOME); assert.equal(mac.PATH, '/Users/u/.versum-node/app/python/bin'); assert.equal(mac.LANG, 'C.UTF-8')
  assert.ok(!('SUPABASE_KEY' in mac))
})

test('the Seatbelt profile denies by default, denies the network, denies /Users, then opens the python tree and the job dir', () => {
  const p = sandboxProfile({ jobDir: '/Users/u/.versum-node/jobs/a', pythonDir: '/Users/u/.versum-node/app/python', homeDir: '/Users/u' })
  const lines = p.trim().split('\n')
  assert.equal(lines[0], '(version 1)'); assert.equal(lines[1], '(deny default)')
  assert.ok(lines.includes('(deny network*)'))
  const data = lines.findIndex((l) => l === '(deny file-read* file-write* (subpath "/System/Volumes/Data"))')
  const sys = lines.findIndex((l) => l.startsWith('(allow file-read* (subpath "/usr/lib")'))
  const py = lines.findIndex((l) => l === '(allow file-read* (subpath "/Users/u/.versum-node/app/python"))')
  const job = lines.findIndex((l) => l === '(allow file-read* file-write* (subpath "/Users/u/.versum-node/jobs/a"))')
  assert.ok(sys > 0 && data > sys && py > data && job > py, 'later rules win: the data-volume deny follows the /System allow, the two job allows come last')
  assert.ok(lines.includes('(allow file-read-metadata)'), 'stat anywhere, so getcwd and path resolution work')
  assert.ok(!lines.some((l) => /\(literal "\/Users"\)|\(literal "\/Library"\)/.test(l)), '/Users and /Library are not listable')
  assert.ok(!lines.some((l) => /\(allow file-read\* .*\(subpath "\/Users"\)/.test(l)))
  assert.ok(lines.includes('(allow process-exec (subpath "/Users/u/.versum-node/app/python"))'))
  assert.ok(!p.includes('(allow network'))
})

test('ps cputime and the process-group totals', () => {
  assert.equal(cpuTimeToSeconds('0:01.23'), 1.23)
  assert.equal(cpuTimeToSeconds('1:02:03'), 3723)
  assert.equal(cpuTimeToSeconds('2-01:00:00'), 176400)
  const s = parsePs('  100  2048 0:01.00\n  200   512 0:00.50\n  100  1024 0:02.00\n', 100)
  assert.deepEqual(s, { rssMb: 3, cpuSeconds: 3, processes: 2 })
})

test('the probe verdict names every open door', () => {
  assert.deepEqual(probeVerdict({ network_blocked: true, loopback_blocked: true, users_dir_blocked: true, home_write_blocked: true, out_write_ok: true, cwd_ok: true }), { ok: true, failures: [] })
  const v = probeVerdict({ network_blocked: false, loopback_blocked: true, users_dir_blocked: true, home_write_blocked: true, out_write_ok: true, cwd_ok: true })
  assert.equal(v.ok, false); assert.match(v.failures[0], /network_blocked/)
  assert.equal(probeVerdict(null).failures.length, 6)
})

test('runtime order: native first on Windows/macOS, containers on Linux, the owner can name one', () => {
  assert.deepEqual(runtimeOrder(null, 'win32'), ['native', 'docker', 'podman'])
  assert.deepEqual(runtimeOrder(null, 'darwin'), ['native', 'docker', 'podman'])
  assert.deepEqual(runtimeOrder(null, 'linux'), ['podman', 'docker'])
  assert.deepEqual(runtimeOrder('docker', 'win32'), ['docker'])
  assert.deepEqual(runtimeOrder('native', 'linux'), ['native'])
})

test('detectNative: no python tree → a reason, never a throw; Linux is told it has no native sandbox', async () => {
  const r = await detectNative({ appRoot: '/nonexistent', env: {}, platform: 'win32' })
  assert.equal(r.ok, false); assert.match(r.reasons[0], /no embedded Python/)
  const l = await detectNative({ appRoot: root, env: {}, platform: 'linux' })
  assert.equal(l.ok, false); assert.match(l.reasons[0], /Windows and macOS only/)
  assert.equal(findPython({ appRoot: '/nonexistent', env: {}, platform: 'darwin' }), null)
})

test('dirSizeBytes counts regular files only', () => {
  const d = mkdtempSync(join(tmpdir(), 'vn-size-'))
  mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'a'), 'x'.repeat(100)); writeFileSync(join(d, 'sub', 'b'), 'y'.repeat(50))
  assert.equal(dirSizeBytes(d), 150)
})

// ── the plumbing, with the system Python and no sandbox (Linux CI) ──
const sysPython = (() => { for (const p of ['/usr/bin/python3', '/usr/local/bin/python3']) if (existsSync(p)) return p; return null })()
test('the native executor runs a script through the runner: inputs, piece.json, env, out/ collected, dir wiped', { skip: !sysPython || process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vn-home-'))
  const script = join(home, 'main.py')
  writeFileSync(script, 'import os, json, sys\nprint("PROGRESS half")\nd = os.environ["VERSUM_JOB_DIR"]\nargs = json.load(open(os.path.join(d, "piece.json")))["args"]\nopen(os.path.join(d, "out", "r.txt"), "w").write(json.dumps({"shard": args["shard"], "threads": os.environ.get("THREADS"), "tmp": os.environ.get("TMPDIR"), "argv": sys.argv[1:]}))\nsys.stderr.write("note\\n")\n')
  const m = manifest(); m.inputs[0].path = script
  const exec = createNativeExecutor({ python: { exe: sysPython, dir: dirname(dirname(sysPython)) }, sandbox: 'none', home, platform: process.platform, hostEnv: {}, log: () => {} })
  const r = await runAttempt({ manifest: m, share: { allow_network: false, gpu: false }, exec, home, log: () => {}, local: true })
  assert.equal(r.outcome, 'succeeded', r.failure_reason + ' ' + r.stderr_tail)
  const out = JSON.parse(readFileSync(join(r.job_dir, 'out', 'r.txt'), 'utf8'))
  assert.equal(out.shard, 1); assert.equal(out.threads, '2'); assert.equal(out.tmp, join(r.job_dir, 'tmp'))
  assert.deepEqual(out.argv, ['--out', join(r.job_dir, 'out'), 'plain'])
  assert.deepEqual(r.outputs, ['r.txt']); assert.equal(r.stderr_tail, 'note')
})

test('the time limit kills a native job and the outcome is timeout', { skip: !sysPython || process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vn-home-'))
  const script = join(home, 'main.py'); writeFileSync(script, 'import time\ntime.sleep(30)\n')
  const m = validateManifest({ ...manifest(), limits: { ...manifest().limits, time_limit_minutes: 1 } }); m.inputs[0].path = script
  const exec = createNativeExecutor({ python: { exe: sysPython, dir: dirname(dirname(sysPython)) }, sandbox: 'none', home, hostEnv: {}, log: () => {} })
  const t = Date.now()
  const orig = m.limits.time_limit_minutes
  m.limits.time_limit_minutes = 0.03   // ~2 s; the manifest is already validated
  const r = await runAttempt({ manifest: m, share: {}, exec, home, log: () => {}, local: true })
  assert.equal(r.outcome, 'timeout'); assert.ok(Date.now() - t < 15_000); assert.equal(orig, 1)
})

test('the disk watch kills a job that fills its directory', { skip: !sysPython || process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vn-home-'))
  const script = join(home, 'main.py'); writeFileSync(script, 'import os, time\nf = open(os.path.join(os.environ["VERSUM_JOB_DIR"], "out", "big"), "wb")\nf.write(b"0" * (3 * 1024 * 1024)); f.flush()\ntime.sleep(20)\n')
  const m = validateManifest({ ...manifest(), limits: { ...manifest().limits, disk_mb: 1 } }); m.inputs[0].path = script
  const exec = createNativeExecutor({ python: { exe: sysPython, dir: dirname(dirname(sysPython)) }, sandbox: 'none', home, hostEnv: {}, log: () => {} })
  const r = await runAttempt({ manifest: m, share: {}, exec, home, log: () => {}, local: true })
  assert.equal(r.outcome, 'failed'); assert.match(r.failure_reason, /disk limit/)
})

test('makeExecutor hands back the native executor for a native detection and refuses a dead runtime', () => {
  assert.throws(() => makeExecutor({ ok: false }, { home: '/x', egressDir: '/e' }), /no usable runtime/)
  const e = makeExecutor({ ok: true, kind: 'native', python: { exe: 'p', dir: 'd' }, helper: null, sandbox: 'seatbelt' }, { home: '/x', egressDir: '/e' })
  assert.equal(e.kind, 'native'); assert.equal(e.mountPath('/j'), '/j')
})

test('the probe script is valid Python and the bundle entry parses', { skip: !sysPython }, () => {
  execFileSync(sysPython, ['-m', 'py_compile', join(root, 'probe', 'sandbox_probe.py')])
})
