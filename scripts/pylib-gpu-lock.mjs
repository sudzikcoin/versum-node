/**
 * Writes pylib-gpu-lock.json — the GPU wheel set a native Windows node downloads when its owner ticks "share the GPU"
 * (lib/pylib-gpu.mjs). Every pin below is resolved against PyPI's JSON API and the PyTorch wheel index at generation
 * time: file name, URL, sha256 and size land in the lock; nothing is resolved on the node. Re-run to bump a pin:
 *
 *   node scripts/pylib-gpu-lock.mjs            # rewrites pylib-gpu-lock.json beside package.json
 *
 * One set per CUDA build the wheels were compiled for. cu128 is the first build that knows Blackwell (sm_120,
 * RTX 50xx) and runs on every driver that reports CUDA >= 12.8; a driver that reports 13.x runs it too (the CUDA
 * driver is backward compatible with older runtimes). The Windows torch wheel bundles the CUDA runtime, cuBLAS,
 * cuDNN, cuFFT, cuRAND, cuSPARSE, cuSOLVER, NVRTC and nvJitLink inside torch/lib — that is why it is ~2.6 GB and why
 * the node needs nothing from the owner but the display driver.
 *
 * numpy is NOT in this set: the base set (pylib-lock.json) already pins numpy 2.1.3, which satisfies cupy
 * (>=2.0,<2.6) and numba (>=1.22,<2.6). numba-cuda is left out on purpose: it drags in cuda-bindings + cuda-core,
 * a second driver-binding stack this release does not verify.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SETS = {
  cu128: {
    cuda_major: 12,
    min_driver_cuda: '12.8',
    torch: { version: '2.9.1+cu128', index: 'https://download.pytorch.org/whl/cu128/torch/' },
    // torch's own Windows dependencies (requires_dist without Linux-only nvidia-* and triton), then cupy and numba
    pypi: [
      ['filelock', '4.2.4'], ['typing_extensions', '4.16.0'], ['setuptools', '84.2.1'], ['sympy', '1.14.0'], ['mpmath', '1.4.1'],
      ['networkx', '3.7'], ['jinja2', '3.1.6'], ['markupsafe', '3.0.4'], ['fsspec', '2026.9.0'],
      ['cupy-cuda12x', '14.2.0'], ['cuda-pathfinder', '1.8.4'],
      ['numba', '0.68.0'], ['llvmlite', '0.50.0'],
    ],
  },
}
const PLATFORM = 'win32-x64'
const TAGS = ['cp312-cp312-win_amd64', 'py3-none-any', 'py2.py3-none-any']

async function getJson(url) { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json() }

async function fromPypi(name, version) {
  const j = await getJson(`https://pypi.org/pypi/${name}/${version}/json`)
  for (const tag of TAGS) {
    const f = j.urls.find((u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith(`-${tag}.whl`))
    if (f) return { name: j.info.name, version, file: f.filename, url: f.url, sha256: f.digests.sha256, size: f.size }
  }
  throw new Error(`${name}==${version}: no wheel for ${TAGS.join(' | ')} (${j.urls.map((u) => u.filename).join(', ')})`)
}

async function torchFromIndex({ version, index }) {
  const html = await (await fetch(index, { signal: AbortSignal.timeout(30_000) })).text()
  const file = `torch-${version}-cp312-cp312-win_amd64.whl`
  const re = new RegExp(`href="([^"#]*${file.replace(/\+/g, '%2B').replace(/\./g, '\\.')})#sha256=([0-9a-f]{64})"`)
  const m = re.exec(html)
  if (!m) throw new Error(`${file} is not in ${index}`)
  const url = decodeURIComponent(m[1])
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  const size = Number(head.headers.get('content-length') ?? 0)
  if (!head.ok || !size) throw new Error(`${file}: HEAD ${head.status}, content-length ${size}`)
  return { name: 'torch', version, file, url, sha256: m[2], size }
}

const lock = {
  lock_version: 1,
  python: '3.12',
  source: 'scripts/pylib-gpu-lock.mjs — PyPI + download.pytorch.org, resolved ' + new Date().toISOString().slice(0, 10),
  sets: {},
  platforms: { [PLATFORM]: {} },
}
for (const [key, s] of Object.entries(SETS)) {
  const wheels = [await torchFromIndex(s.torch)]
  for (const [n, v] of s.pypi) wheels.push(await fromPypi(n, v))
  lock.sets[key] = { cuda_major: s.cuda_major, min_driver_cuda: s.min_driver_cuda, packages: wheels.map((w) => `${w.name}==${w.version}`), bytes_total: wheels.reduce((a, w) => a + w.size, 0) }
  lock.platforms[PLATFORM][key] = wheels
  console.log(`${key}: ${wheels.length} wheels, ${(lock.sets[key].bytes_total / 1073741824).toFixed(2)} GB`)
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'pylib-gpu-lock.json')
writeFileSync(out, JSON.stringify(lock, null, 1) + '\n')
console.log(`wrote ${out}`)
