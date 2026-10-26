import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, createReadStream, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { parseNvidiaSmiCsv, parseNvidiaSmiCuda, parseVideoControllers, gpuBlock, describeGpu, gpuPageLines, parseIcacls, nvidiaDriverDirs, detectGpu, NO_GPU, vendorOf } from '../lib/gpu-detect.mjs'
import { gpuSetFor, gpuPlanFor, gpuStampOf, describeGpuPylib, gpuPackagesWord, gpuJobEnv, ensureGpuPackages, ensureGpuGrants } from '../lib/pylib-gpu.mjs'

const execFileP = promisify(execFile)
const lock = JSON.parse(readFileSync(new URL('../pylib-gpu-lock.json', import.meta.url), 'utf8'))
const SMI_CSV = 'NVIDIA GeForce RTX 5070 Ti, 16303, 572.16\n'
const SMI_HEADER = `Sat Oct 25 20:11:02 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 572.16                 Driver Version: 572.16         CUDA Version: 12.8     |
|-----------------------------------------+------------------------+----------------------+
`
const rtx = { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 5070 Ti', vram_mb: 16303, cuda: '12.8', driver: '572.16', count: 1 }

test('detection parsers: nvidia-smi csv + header, the Win32_VideoController fallback, the heartbeat block', () => {
  const gpus = parseNvidiaSmiCsv(SMI_CSV)
  assert.deepEqual(gpus, [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 5070 Ti', vram_mb: 16303, driver: '572.16' }])
  assert.equal(parseNvidiaSmiCuda(SMI_HEADER), '12.8')
  assert.equal(parseNvidiaSmiCuda('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.'), null)
  assert.deepEqual(parseNvidiaSmiCsv('No devices were found\n'), [])
  assert.deepEqual(gpuBlock(gpus, '12.8'), rtx)
  assert.deepEqual(gpuBlock([], null), NO_GPU)
  const two = parseNvidiaSmiCsv('NVIDIA RTX A6000, 49140, 560.94\nNVIDIA RTX A6000, 49140, 560.94\n')
  assert.equal(gpuBlock(two, '12.6').count, 2)
  // the fallback knows the adapter and the driver, never CUDA; AdapterRAM over 4 GB is clipped by WMI and so unknown
  const vc = parseVideoControllers(JSON.stringify([{ Name: 'NVIDIA GeForce RTX 5070 Ti', DriverVersion: '32.0.15.7216', AdapterRAM: 4293918720 }, { Name: 'Microsoft Basic Display Adapter', DriverVersion: '10.0', AdapterRAM: 0 }]))
  assert.deepEqual(vc, [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 5070 Ti', vram_mb: null, driver: '32.0.15.7216' }])
  assert.deepEqual(parseVideoControllers(JSON.stringify({ Name: 'AMD Radeon RX 7800 XT', DriverVersion: '31.0.24027.1012', AdapterRAM: 2147483648 })), [{ vendor: 'amd', model: 'AMD Radeon RX 7800 XT', vram_mb: 2048, driver: '31.0.24027.1012' }])
  assert.deepEqual(parseVideoControllers('not json'), [])
  // a VM's display adapter (the GitHub Windows runner) or any adapter of no known GPU vendor is not a GPU
  assert.deepEqual(parseVideoControllers(JSON.stringify([{ Name: 'Microsoft Hyper-V Video', DriverVersion: '10.0.26100.1', AdapterRAM: 0 }, { Name: 'DisplayLink USB Device', DriverVersion: '1', AdapterRAM: 0 }])), [])
  assert.equal(vendorOf('Intel(R) UHD Graphics 770'), 'intel')
  assert.equal(describeGpu(rtx), 'NVIDIA GeForce RTX 5070 Ti · 15.9 GB · CUDA 12.8 · driver 572.16')
  assert.equal(describeGpu(gpuBlock(vc, null)), 'NVIDIA GeForce RTX 5070 Ti · no CUDA driver found · driver 32.0.15.7216')
  assert.equal(describeGpu(NO_GPU), null)
})

test('detectGpu on a machine without nvidia-smi answers none, never throws, and says why', async () => {
  const enoent = Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })
  const r = await detectGpu({ platform: 'linux', exec: async () => { throw enoent } })
  assert.deepEqual(r.gpu, NO_GPU); assert.equal(r.source, 'none'); assert.match(r.reasons[0], /not found/)
  // macOS: no NVIDIA driver exists, nothing is run
  let ran = 0
  const m = await detectGpu({ platform: 'darwin', exec: async () => { ran++; return { stdout: '' } } })
  assert.equal(ran, 0); assert.equal(m.gpu.count, 0)
  // Windows with the driver: csv then header
  const w = await detectGpu({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => true, exec: async (bin, args) => ({ stdout: args.length ? SMI_CSV : SMI_HEADER }) })
  assert.deepEqual(w.gpu, rtx); assert.equal(w.source, 'nvidia-smi')
  // Windows without nvidia-smi anywhere: the CIM fallback, cuda stays null
  const f = await detectGpu({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => false, exec: async (bin) => { if (bin === 'nvidia-smi') throw enoent; return { stdout: JSON.stringify({ Name: 'NVIDIA GeForce GTX 1060', DriverVersion: '27.21.14.5671', AdapterRAM: 3221225472 }) } } })
  assert.equal(f.source, 'win32_videocontroller'); assert.equal(f.gpu.cuda, null); assert.equal(f.gpu.vram_mb, 3072)
})

test('the local page: boxes and the one grey line, by executor kind and detection', () => {
  assert.deepEqual(gpuPageLines({ native: true, gpu: NO_GPU }), { gpu_box: false, net_box: false, line: 'GPU and network jobs: Linux container nodes only' })
  const nat = gpuPageLines({ native: true, gpu: rtx, gpuPackages: 'GPU packages ready (14 wheels)' })
  assert.equal(nat.gpu_box, true); assert.equal(nat.net_box, false); assert.match(nat.gpu_note, /RTX 5070 Ti.*GPU packages ready/)
  assert.match(gpuPageLines({ native: true, gpu: { ...rtx, cuda: null } }).line, /no CUDA driver found/)
  assert.match(gpuPageLines({ native: true, gpu: { vendor: 'amd', model: 'AMD Radeon RX 7800 XT', count: 1 } }).line, /Linux container nodes only \(AMD Radeon RX 7800 XT has no CUDA\)/)
  assert.deepEqual(gpuPageLines({ native: false, gpu: NO_GPU }), { gpu_box: true, gpu_disabled: true, net_box: true, line: 'No GPU on this machine', gpu_note: '' })
  assert.equal(gpuPageLines({ native: false, gpu: rtx }).gpu_disabled, false)
})

test('the lock: one cu128 set for win32-x64 — torch cu128 from the PyTorch index, cupy and numba from PyPI, every wheel hashed and sized', () => {
  const plan = gpuPlanFor(lock, 'cu128', 'win32', 'x64')
  assert.equal(plan.wheels.length, 14)
  const by = Object.fromEntries(plan.wheels.map((w) => [w.name.toLowerCase().replace(/-/g, '_'), w]))
  assert.equal(by.torch.version, '2.9.1+cu128'); assert.match(by.torch.file, /^torch-2\.9\.1\+cu128-cp312-cp312-win_amd64\.whl$/); assert.match(by.torch.url, /^https:\/\/download(-r2)?\.pytorch\.org\/whl\/cu128\//)
  assert.ok(by.torch.size > 2.5 * 1073741824, 'the Windows torch wheel bundles the CUDA runtime: over 2.5 GB')
  for (const p of ['cupy_cuda12x', 'cuda_pathfinder', 'numba', 'llvmlite', 'sympy', 'networkx', 'jinja2', 'markupsafe', 'filelock', 'fsspec', 'typing_extensions', 'setuptools', 'mpmath']) assert.ok(by[p], `${p} in the set`)
  for (const w of plan.wheels) { assert.match(w.sha256, /^[0-9a-f]{64}$/); assert.ok(w.size > 0); assert.ok(/cp312-cp312-win_amd64|py3-none-any/.test(w.file), w.file) }
  assert.ok(!by.numpy, 'numpy comes from the base set')
  assert.equal(lock.sets.cu128.min_driver_cuda, '12.8')
  assert.ok(plan.bytes_total > 2.6 * 1073741824 && plan.bytes_total < 3.5 * 1073741824)
  assert.deepEqual(gpuPlanFor(lock, 'cu128', 'darwin', 'arm64'), { key: null, wheels: [] })
  assert.throws(() => gpuPlanFor({ platforms: { 'win32-x64': { cu128: [{ file: 'x.whl', url: 'https://evil.example/x.whl', sha256: 'a'.repeat(64) }] } } }, 'cu128', 'win32', 'x64'), /malformed/)
  assert.throws(() => gpuPlanFor(lock, 'cu999', 'win32', 'x64'), /no cu999 wheels/)
})

test('which set for which GPU: cu128 for CUDA 12.8 and 13.0 drivers, nothing for 12.4, AMD, no CUDA, macOS', () => {
  assert.equal(gpuSetFor(lock, rtx, 'win32', 'x64').key, 'cu128')
  assert.equal(gpuSetFor(lock, { ...rtx, cuda: '13.0' }, 'win32', 'x64').key, 'cu128')
  assert.equal(gpuSetFor(lock, { ...rtx, cuda: '12.9' }, 'win32', 'x64').key, 'cu128')
  assert.match(gpuSetFor(lock, { ...rtx, cuda: '12.4' }, 'win32', 'x64').why, /driver CUDA 12.4 is older than the 12.8/)
  assert.match(gpuSetFor(lock, { ...rtx, cuda: null }, 'win32', 'x64').why, /names no CUDA version/)
  assert.match(gpuSetFor(lock, { vendor: 'amd', model: 'Radeon', count: 1 }, 'win32', 'x64').why, /not an NVIDIA GPU/)
  assert.match(gpuSetFor(lock, NO_GPU, 'win32', 'x64').why, /no GPU on this machine/)
  assert.match(gpuSetFor(lock, rtx, 'darwin', 'arm64').why, /Windows x64 only/)
  const a = gpuStampOf(lock, gpuPlanFor(lock, 'cu128', 'win32', 'x64'))
  const changed = JSON.parse(JSON.stringify(lock)); changed.platforms['win32-x64'].cu128[0].sha256 = '0'.repeat(64)
  assert.notEqual(a, gpuStampOf(changed, gpuPlanFor(changed, 'cu128', 'win32', 'x64')))
})

test('words: the page line and the heartbeat word; the job environment puts torch\\lib where CUDA DLLs are looked for', () => {
  assert.equal(describeGpuPylib({ status: 'pending', done: 1, total: 14, bytes_total: 3.02e9, bytes_done: 1.2e9 }), 'preparing GPU packages, 2.8 GB (1.1 GB done, 1 of 14)')
  assert.equal(describeGpuPylib({ status: 'ok', total: 14, checked: '2.9.1+cu128 12.8 NVIDIA GeForce RTX 5070 Ti' }), 'GPU packages ready (14 wheels: 2.9.1+cu128 12.8 NVIDIA GeForce RTX 5070 Ti)')
  assert.equal(describeGpuPylib({ status: 'idle' }), null)
  assert.equal(gpuPackagesWord({ status: 'idle' }), null); assert.equal(gpuPackagesWord({ status: 'pending' }), 'pending'); assert.equal(gpuPackagesWord({ status: 'unsupported' }), 'failed'); assert.equal(gpuPackagesWord({ status: 'ok' }), 'ok')
  const env = gpuJobEnv({ PATH: 'C:\\app\\python', PYTHONPATH: 'C:\\s\\pylib' }, { gpuDir: 'C:\\s\\pylib-gpu', pylibDir: 'C:\\s\\pylib', platform: 'win32' })
  assert.equal(env.PYTHONPATH, 'C:\\s\\pylib-gpu;C:\\s\\pylib'); assert.equal(env.PATH, 'C:\\app\\python;C:\\s\\pylib-gpu\\torch\\lib'); assert.equal(env.CUDA_PATH, 'C:\\s\\pylib-gpu\\torch\\lib')
  assert.deepEqual(gpuJobEnv({ PATH: 'x' }, { gpuDir: null }), { PATH: 'x' })
})

test('the sandbox side: driver folders found in the DriverStore, icacls read for ALL APPLICATION PACKAGES', () => {
  const dirs = nvidiaDriverDirs({ systemRoot: 'C:\\Windows', readdir: () => ['nv_dispi.inf_amd64_8f2a1c3b9d4e5f60', 'nvhda.inf_amd64_1111111111111111', 'prnms003.inf_amd64_abc'], exists: (p) => /nv_dispi.*nvcuda64\.dll$/.test(p) })
  assert.deepEqual(dirs, ['C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispi.inf_amd64_8f2a1c3b9d4e5f60'])
  assert.deepEqual(nvidiaDriverDirs({ readdir: () => { throw new Error('nope') } }), [])
  const stock = `C:\\Windows\\System32\\nvcuda.dll NT SERVICE\\TrustedInstaller:(F)
                                 NT AUTHORITY\\SYSTEM:(RX)
                                 BUILTIN\\Administrators:(RX)
                                 BUILTIN\\Users:(RX)
                                 APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(RX)
                                 APPLICATION PACKAGE AUTHORITY\\ALL RESTRICTED APPLICATION PACKAGES:(RX)

Successfully processed 1 files; Failed processing 0 files`
  assert.equal(parseIcacls(stock).app_packages_read, true)
  const none = `C:\\x\\pylib-gpu BUILTIN\\Administrators:(I)(OI)(CI)(F)
             DESKTOP\\owner:(I)(OI)(CI)(F)`
  assert.equal(parseIcacls(none).app_packages_read, false)
  assert.equal(parseIcacls('C:\\d S-1-15-2-1:(OI)(CI)(RX)').app_packages_read, true)
  assert.equal(parseIcacls('C:\\d APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(OI)(CI)(W)').app_packages_read, false, 'write only is not read')
})

/* ───────────── the installer, end to end on Linux with tiny wheels and a fake network ───────────── */

const haveLocalPython = (() => { try { return !!execFileP && existsSync('/usr/bin/python3') } catch { return false } })()

async function tinyWheel(dir, name, version, src) {
  const file = `${name}-${version}-py3-none-any.whl`
  const path = join(dir, file)
  await execFileP('/usr/bin/python3', ['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('${name}/__init__.py', sys.argv[2])\nz.close()`, path, src])
  const buf = readFileSync(path)
  return { name, version, file, url: `https://files.pythonhosted.org/packages/aa/bb/${file}`, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, path }
}

function fakeFetch(files, { ranges = true, log = [] } = {}) {
  return async (url, { headers = {} } = {}) => {
    const w = Object.values(files).find((f) => f.url === url)
    if (!w) return new Response(null, { status: 404 })
    const size = statSync(w.path).size
    const m = /^bytes=(\d+)-$/.exec(headers.range ?? '')
    log.push({ file: w.file, range: m ? Number(m[1]) : null })
    if (m && ranges) {
      const start = Number(m[1])
      if (start >= size) return new Response(null, { status: 416 })
      return new Response(Readable.toWeb(createReadStream(w.path, { start })), { status: 206, headers: { 'content-range': `bytes ${start}-${size - 1}/${size}` } })
    }
    return new Response(Readable.toWeb(createReadStream(w.path)), { status: 200, headers: { 'content-length': String(size) } })
  }
}

test('ensureGpuPackages: downloads (resuming a partial), verifies, unpacks, checks the device, stamps; a second start is instant', { skip: !haveLocalPython && 'needs /usr/bin/python3' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gpu-pylib-'))
  const src = join(root, 'src'); mkdirSync(src)
  const a = await tinyWheel(src, 'torch', '2.9.1+cu128', 'cuda = True\n'), b = await tinyWheel(src, 'cupy_cuda12x', '14.2.0', 'x = 1\n')
  const l = { lock_version: 1, sets: { cu128: { cuda_major: 12, min_driver_cuda: '12.8' } }, platforms: { 'win32-x64': { cu128: [a, b] } } }
  const state = join(root, 'state'); mkdirSync(state)
  // a partial torch from an earlier, interrupted run
  mkdirSync(join(state, 'pylib-gpu-dl')); writeFileSync(join(state, 'pylib-gpu-dl', a.file), readFileSync(a.path).subarray(0, 40))
  const calls = []
  const exec = async (bin, args, opts) => {
    if (args.some((x) => /import torch/.test(x))) { calls.push({ check: true, env: opts.env }); return { stdout: '2.9.1+cu128 12.8 NVIDIA GeForce RTX 5070 Ti\n' } }
    return execFileP('/usr/bin/python3', args, {})   // the real zipfile unpack with the local interpreter
  }
  const logs = [], net = []
  const p = await ensureGpuPackages({ lock: l, stateDir: state, pythonExe: '/usr/bin/python3', gpu: rtx, pylibDir: join(state, 'pylib'), platform: 'win32', arch: 'x64', log: (s) => logs.push(s), fetchFn: fakeFetch({ a, b }, { log: net }), exec })
  assert.equal(p.status, 'ok', logs.join('\n'))
  assert.equal(p.done, 2); assert.equal(p.set, 'cu128'); assert.equal(p.bytes_done, a.size + b.size); assert.equal(p.checked, '2.9.1+cu128 12.8 NVIDIA GeForce RTX 5070 Ti')
  assert.deepEqual(net.map((n) => n.range), [40, null], 'torch resumed at byte 40, cupy fetched whole')
  assert.ok(existsSync(join(state, 'pylib-gpu', 'torch', '__init__.py')) && existsSync(join(state, 'pylib-gpu', 'cupy_cuda12x', '__init__.py')))
  assert.ok(!existsSync(join(state, 'pylib-gpu-dl')), 'downloads wiped after a good install')
  assert.equal(calls[0].env.PYTHONPATH, `${join(state, 'pylib-gpu')};${join(state, 'pylib')}`)
  assert.match(calls[0].env.CUDA_PATH, /pylib-gpu\\torch\\lib$/)
  // the second start: marker matches, no network, no exec
  const again = await ensureGpuPackages({ lock: l, stateDir: state, pythonExe: '/usr/bin/python3', gpu: rtx, pylibDir: null, platform: 'win32', arch: 'x64', fetchFn: async () => { throw new Error('no network expected') }, exec: async () => { throw new Error('no exec expected') } })
  assert.equal(again.status, 'ok'); assert.equal(again.done, 2); assert.equal(again.checked, '2.9.1+cu128 12.8 NVIDIA GeForce RTX 5070 Ti')
})

test('ensureGpuPackages: a wrong sha fails after three attempts, a device that torch does not see fails with the reason, no GPU is unsupported', { skip: !haveLocalPython && 'needs /usr/bin/python3' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gpu-pylib-'))
  const src = join(root, 'src'); mkdirSync(src)
  const a = await tinyWheel(src, 'torch', '2.9.1+cu128', 'x = 1\n')
  const bad = { ...a, sha256: 'f'.repeat(64) }
  const mk = (wheel) => ({ lock_version: 1, sets: { cu128: { min_driver_cuda: '12.8' } }, platforms: { 'win32-x64': { cu128: [wheel] } } })
  const s1 = join(root, 's1'); mkdirSync(s1)
  const net = []
  const p1 = await ensureGpuPackages({ lock: mk(bad), stateDir: s1, pythonExe: '/usr/bin/python3', gpu: rtx, pylibDir: null, platform: 'win32', arch: 'x64', fetchFn: fakeFetch({ a }, { log: net }), exec: async () => ({ stdout: '' }) })
  assert.equal(p1.status, 'failed'); assert.match(p1.error, /sha256 .* does not match the lock/); assert.equal(net.length, 3)
  const s2 = join(root, 's2'); mkdirSync(s2)
  const p2 = await ensureGpuPackages({ lock: mk(a), stateDir: s2, pythonExe: '/usr/bin/python3', gpu: rtx, pylibDir: null, platform: 'win32', arch: 'x64', fetchFn: fakeFetch({ a }), exec: async (bin, args) => { if (args.some((x) => /import torch/.test(x))) throw Object.assign(new Error('exit 7'), { code: 7, stdout: '2.9.1+cu128 12.8 NO-DEVICE' }); return execFileP('/usr/bin/python3', args) } })
  assert.equal(p2.status, 'failed'); assert.match(p2.error, /is_available\(\) is False on this machine \(2.9.1\+cu128 12.8 NO-DEVICE\)/)
  const s3 = join(root, 's3'); mkdirSync(s3)
  const p3 = await ensureGpuPackages({ lock: mk(a), stateDir: s3, pythonExe: '/usr/bin/python3', gpu: NO_GPU, pylibDir: null, platform: 'win32', arch: 'x64', fetchFn: async () => { throw new Error('no network expected') }, exec: async () => { throw new Error('no exec expected') } })
  assert.equal(p3.status, 'unsupported'); assert.equal(gpuPackagesWord(p3), 'failed'); assert.match(p3.error, /no GPU on this machine/)
})

test('ensureGpuGrants: grant-read on our folder once per stamp; the driver folders are checked, never changed', async () => {
  const state = mkdtempSync(join(tmpdir(), 'gpu-grant-'))
  const calls = []
  const exec = async (bin, args) => { calls.push([bin, ...args]); if (bin === 'icacls') return { stdout: args[0].includes('nvcuda') ? 'C:\\Windows\\System32\\nvcuda.dll APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(RX)' : 'C:\\drv BUILTIN\\Users:(RX)' }; return { stdout: '' } }
  const r = await ensureGpuGrants({ helper: 'C:\\app\\versum-sandbox.exe', gpuDir: 'C:\\s\\pylib-gpu', stamp: 'abc', stateDir: state, exec, env: { SystemRoot: 'C:\\Windows' }, driverDirs: () => ['C:\\drv'] })
  assert.equal(r.granted, true)
  assert.deepEqual(calls[0], ['C:\\app\\versum-sandbox.exe', 'grant-read', '--dir', 'C:\\s\\pylib-gpu'])
  assert.deepEqual(r.driver_dirs.map((d) => d.app_packages_read), [true, false])
  assert.ok(!calls.some((c) => c[0] !== 'icacls' && c[1] === 'grant-read' && c[3] === 'C:\\drv'), 'the DriverStore is never granted by us')
  const calls2 = []
  await ensureGpuGrants({ helper: 'h', gpuDir: 'C:\\s\\pylib-gpu', stamp: 'abc', stateDir: state, exec: async (bin, args) => { calls2.push(bin); return { stdout: '' } }, env: { SystemRoot: 'C:\\Windows' }, driverDirs: () => [] })
  assert.ok(!calls2.includes('h'), 'same stamp: no second grant')
  assert.deepEqual(await ensureGpuGrants({ sandbox: 'seatbelt', gpuDir: 'x' }), { granted: false, driver_dirs: [] })
})

/* ───────────── the sandbox probe the node runs on itself (lib/gpu-probe.mjs) ───────────── */
import { probeVerdict, describeGpuProbe, probeManifest, runGpuProbe, PROBE_FILE, VERDICTS } from '../lib/gpu-probe.mjs'
import { createNativeExecutor, fitsNative, nativeCommand } from '../lib/native.mjs'
import { runAttempt } from '../lib/runner.mjs'
import { validateManifest } from '../lib/manifest.mjs'
import { dirname } from 'node:path'

const ok = (extra = {}) => ({ ok: true, ms: 1, ...extra })
const fail = (error) => ({ ok: false, ms: 1, error })

test('probeVerdict: no GPU answers without a run; the driver failing bare is the machine, not the sandbox; inside decides', () => {
  assert.equal(probeVerdict({ gpu: NO_GPU }).verdict, 'no_gpu')
  assert.match(probeVerdict({ gpu: { vendor: 'amd', model: 'Radeon', count: 1 } }).detail, /not an NVIDIA GPU/)
  assert.match(probeVerdict({ gpu: { ...rtx, cuda: null } }).detail, /no CUDA driver found/)
  const bareNo = probeVerdict({ gpu: rtx, bare: { nvcuda: fail('OSError: Could not find module nvcuda.dll'), verdict: 'no_gpu' } })
  assert.equal(bareNo.verdict, 'no_gpu'); assert.match(bareNo.detail, /even outside the sandbox/)
  const bareOk = { nvcuda: ok({ name: 'NVIDIA GeForce RTX 5070 Ti', driver_cuda: '12.8' }), torch: fail('ModuleNotFoundError: torch'), verdict: 'driver_ok' }
  const none = probeVerdict({ gpu: rtx, bare: bareOk, sandboxed: null, sandboxExit: -1073741515, sandboxStderr: 'x' })
  assert.equal(none.verdict, 'blocked'); assert.match(none.detail, /wrote no result \(exit -1073741515\)/)
  const inOk = probeVerdict({ gpu: rtx, stage: 'driver', bare: bareOk, sandboxed: { nvcuda: ok({ name: 'NVIDIA GeForce RTX 5070 Ti', driver_cuda: '12.8' }), torch: fail('ModuleNotFoundError') } })
  assert.equal(inOk.verdict, 'appcontainer_ok'); assert.equal(inOk.step, 'nvcuda'); assert.match(inOk.detail, /cuCtxCreate ok inside the AppContainer \(NVIDIA GeForce RTX 5070 Ti, driver CUDA 12.8\)/)
  const inNo = probeVerdict({ gpu: rtx, stage: 'driver', bare: bareOk, sandboxed: { nvcuda: fail('RuntimeError: cuInit returned 304 OPERATING_SYSTEM') } })
  assert.equal(inNo.verdict, 'blocked'); assert.match(inNo.detail, /first failing call is nvcuda: RuntimeError: cuInit returned 304/)
  // the torch stage: the step that must pass inside is torch; a set broken even bare is said as such
  const t = probeVerdict({ gpu: rtx, stage: 'torch', bare: { nvcuda: ok(), torch: ok() }, sandboxed: { nvcuda: ok(), torch: ok({ version: '2.9.1+cu128', device: 'NVIDIA GeForce RTX 5070 Ti', matmul_ms: 12 }) } })
  assert.equal(t.verdict, 'appcontainer_ok'); assert.match(t.detail, /torch 2.9.1\+cu128 matmul on NVIDIA GeForce RTX 5070 Ti inside the AppContainer in 12 ms/)
  const tb = probeVerdict({ gpu: rtx, stage: 'torch', bare: { nvcuda: ok(), torch: ok() }, sandboxed: { nvcuda: ok(), torch: fail('RuntimeError: torch.cuda.is_available() is False') } })
  assert.equal(tb.verdict, 'blocked'); assert.match(tb.detail, /first failing call is torch: RuntimeError/)
  const broken = probeVerdict({ gpu: rtx, stage: 'torch', bare: { nvcuda: ok(), torch: fail('ImportError: DLL load failed') } })
  assert.equal(broken.verdict, 'blocked'); assert.equal(broken.set_broken, true)
  assert.match(describeGpuProbe({ verdict: 'appcontainer_ok', detail: 'd' }), /^GPU inside the sandbox: works — d$/)
  assert.match(describeGpuProbe({ status: 'running', stage: 'driver' }), /checking whether CUDA works/)
  assert.equal(describeGpuProbe(null), null)
})

test('probeManifest: a valid manifest, GPU env only in the torch stage, the probe marked as the sandboxed run', () => {
  const d = probeManifest({ id: '11111111-1111-4111-8111-111111111111', stage: 'driver', probePath: '/p/gpu_probe.py' })
  assert.equal(d.limits.gpu, false); assert.equal(d.env.VERSUM_PROBE_MODE, 'appcontainer'); assert.equal(d.inputs[0].path, '/p/gpu_probe.py'); assert.equal(d.limits.ram_mb, 1024)
  const t = probeManifest({ id: '11111111-1111-4111-8111-111111111111', stage: 'torch', probePath: '/p/gpu_probe.py' })
  assert.equal(t.limits.gpu, true); assert.equal(t.limits.time_limit_minutes, 10)
  // a GPU manifest is refused by a node without a ready set, taken with one
  assert.match(fitsNative(t), /no ready GPU package set/); assert.equal(fitsNative(t, { gpuReady: true }), null)
  assert.throws(() => nativeCommand(t, { jobDir: '/j', python: 'py', platform: 'linux' }), /GPU/)
})

const sysPy = ['/usr/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null
test('runGpuProbe end to end on this machine (no sandbox, no GPU): both halves run the real probe, result.json is read, the verdict is cached', { skip: !sysPy || process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vn-gpu-probe-'))
  const state = join(home, 'state'); mkdirSync(state)
  const appRoot = join(dirname(new URL(import.meta.url).pathname), '..')
  const exec = createNativeExecutor({ python: { exe: sysPy, dir: dirname(dirname(sysPy)) }, sandbox: 'none', home, hostEnv: {}, log: () => {} })
  const logs = []
  // no GPU: answered from detection, nothing runs, cached
  const none = await runGpuProbe({ home, appRoot, stateDir: state, gpu: NO_GPU, exec, pythonExe: sysPy, pythonDir: dirname(dirname(sysPy)), log: (l) => logs.push(l) })
  assert.equal(none.verdict, 'no_gpu'); assert.equal(none.bare, null); assert.ok(existsSync(join(state, PROBE_FILE)))
  assert.equal((await runGpuProbe({ home, appRoot, stateDir: state, gpu: NO_GPU, exec, pythonExe: sysPy, pythonDir: '/x' })).cached, true)
  // pretend an NVIDIA GPU with CUDA: the probe runs bare (libcuda.so.1 is not here → the machine's answer) and, forced, inside the executor too
  const r = await runGpuProbe({ home, appRoot, stateDir: state, gpu: rtx, exec, pythonExe: sysPy, pythonDir: dirname(dirname(sysPy)), force: true, log: (l) => logs.push(l) })
  assert.equal(r.verdict, 'no_gpu', logs.join('\n')); assert.ok(r.bare && r.bare.nvcuda.ok === false, 'bare half ran the real gpu_probe.py'); assert.equal(r.bare.in_sandbox, 'bare')
  assert.ok(r.sandboxed && r.sandboxed.nvcuda.ok === false, 'sandboxed half ran through the executor'); assert.equal(r.sandboxed.in_sandbox, 'appcontainer'); assert.equal(r.sandboxed.verdict, 'no_gpu')
  assert.ok(r.bare.numba, 'every step is recorded, even the ones that cannot import')
  assert.deepEqual(readdirSync(join(home, 'jobs')), [], 'both job directories wiped')
  const cached = JSON.parse(readFileSync(join(state, PROBE_FILE), 'utf8'))
  assert.equal(cached.verdict, 'no_gpu'); assert.equal(cached.key.model, rtx.model)
})

test('a GPU job gets the GPU environment through the real executor (no sandbox): PYTHONPATH gpu;base, CUDA_PATH = torch/lib', { skip: !sysPy || process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vn-gpu-env-'))
  const script = join(home, 'main.py'); writeFileSync(script, 'import os, json\nopen(os.path.join(os.environ["VERSUM_JOB_OUT"], "env.json"), "w").write(json.dumps({k: os.environ.get(k) for k in ("PYTHONPATH", "CUDA_PATH", "PATH")}))\n')
  const id = '22222222-2222-4222-8222-222222222222'
  const m = validateManifest({ attempt_id: id, piece_id: id, job_id: id, kind: 'python', image: 'ghcr.io/sudzikcoin/versum-python@sha256:' + 'f'.repeat(64), command: ['python', '/job/in/main.py'], env: {}, args: {}, limits: { cpu_cores: 1, ram_mb: 256, disk_mb: 64, gpu: true, network: false, time_limit_minutes: 1 }, inputs: [{ name: 'main.py', url: 'https://localhost/x', size_bytes: 0 }], price_per_minute_usd: 0 })
  m.inputs[0].path = script
  const gpu = { status: 'ok', dir: '/s/pylib-gpu', ready: true }
  const exec = createNativeExecutor({ python: { exe: sysPy, dir: dirname(dirname(sysPy)) }, sandbox: 'none', home, hostEnv: {}, log: () => {}, pylib: { status: 'ok', dir: '/s/pylib' }, gpu })
  assert.equal(exec.gpuReady(), true)
  const r = await runAttempt({ manifest: m, share: { gpu: true }, exec, home, log: () => {}, local: true })
  assert.equal(r.outcome, 'succeeded', r.failure_reason + ' ' + r.stderr_tail)
  const env = JSON.parse(readFileSync(join(r.job_dir, 'out', 'env.json'), 'utf8'))
  assert.equal(env.PYTHONPATH, '/s/pylib-gpu:/s/pylib'); assert.equal(env.CUDA_PATH, '/s/pylib-gpu/torch/lib'); assert.match(env.PATH, /\/s\/pylib-gpu\/torch\/lib$/)
  // the same job is refused while the probe has not passed
  gpu.ready = false
  assert.equal(exec.gpuReady(), false)
  const r2 = await runAttempt({ manifest: m, share: { gpu: true }, exec, home, log: () => {}, local: true })
  assert.equal(r2.outcome, 'failed'); assert.match(r2.failure_reason, /no ready GPU package set/)
})

test('0.4.6: the restricted-token fallback — the same comparison with mode jobobject answers jobobject_ok, and the page says so', () => {
  const gpu = { vendor: 'nvidia', model: 'RTX 5070 Ti', cuda: '12.8', count: 1 }
  const bare = { nvcuda: { ok: true, name: 'RTX 5070 Ti', driver_cuda: '12.8' } }
  const blocked = probeVerdict({ gpu, stage: 'driver', bare, sandboxed: { nvcuda: { ok: false, error: 'CUDA_ERROR_NO_DEVICE' } } })
  assert.equal(blocked.verdict, 'blocked'); assert.match(blocked.detail, /inside the AppContainer/)
  const jo = probeVerdict({ gpu, stage: 'driver', bare, sandboxed: bare, mode: 'jobobject' })
  assert.equal(jo.verdict, 'jobobject_ok'); assert.match(jo.detail, /inside the restricted-token sandbox/)
  assert.equal(probeVerdict({ gpu, stage: 'driver', bare, sandboxed: null, sandboxExit: 1, mode: 'jobobject' }).verdict, 'blocked')
  assert.match(describeGpuProbe({ verdict: 'jobobject_ok', detail: 'x', firewall: true }), /works in restricted-token mode/)
  assert.match(describeGpuProbe({ verdict: 'jobobject_ok', detail: 'x', firewall: false }), /WAITING for the one-time firewall rule/)
  assert.ok(VERDICTS.includes('jobobject_ok'))
})
