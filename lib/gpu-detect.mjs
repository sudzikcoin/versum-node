/**
 * 0.4.4 — what GPU this machine has, said once at start and on every full scan, for the heartbeat and the local page.
 *
 *   NVIDIA   nvidia-smi ships INSIDE the display driver on Windows (C:\Windows\System32\nvidia-smi.exe) and with the
 *            Linux driver; it is asked twice: a CSV query (name, VRAM, driver version) and its plain header, the only
 *            place the driver's CUDA version is printed ("CUDA Version: 12.8"). No NVML binding: Node has no FFI, and
 *            nvidia-smi is NVML with a command line.
 *   fallback Windows without nvidia-smi on PATH or in System32: Win32_VideoController through PowerShell names the
 *            adapter and the driver version but knows no CUDA version — such a GPU is reported with cuda: null and the
 *            GPU package set stays unavailable ("no CUDA driver").
 *   none     AMD/Intel/Apple GPUs are reported with their vendor and no cuda; the GPU box is for CUDA only in 0.4.4.
 *
 * Heartbeat shape (resources.gpu): { vendor, model, vram_mb, cuda, driver, count } — vendor 'nvidia' | 'amd' | 'intel'
 * | 'apple' | null, cuda as the driver reports it ("12.8") or null. The old flat gpu_count/gpu_model/gpu_vram_mb fields
 * of scan.mjs stay as they are; this block is added beside them.
 *
 * Every parser is pure (text in, object out) and tested on fixtures; detectGpu() is the only function that runs anything.
 * Also here: the folders an AppContainer must read to reach the driver (nvidiaDriverDirs) and the icacls check that
 * says whether ALL APPLICATION PACKAGES already may (parseIcacls) — the sandbox side of the GPU question.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const NVIDIA_SMI_QUERY = ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']
export const NO_GPU = Object.freeze({ vendor: null, model: null, vram_mb: null, cuda: null, driver: null, count: 0 })

/** Pure: the vendor from an adapter name. */
export function vendorOf(name) {
  const n = String(name ?? '').toLowerCase()
  if (/nvidia|geforce|quadro|tesla|rtx/.test(n)) return 'nvidia'
  if (/\bamd\b|radeon|\bati\b/.test(n)) return 'amd'
  if (/intel|arc\b|iris|uhd/.test(n)) return 'intel'
  if (/apple/.test(n)) return 'apple'
  return null
}

/** Pure: nvidia-smi CSV (one line per GPU: "NVIDIA GeForce RTX 5070 Ti, 16303, 572.16") → the gpus. */
export function parseNvidiaSmiCsv(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^no devices|^nvidia-smi has failed/i.test(l)).map((l) => {
    const [name, mem, driver] = l.split(',').map((s) => s.trim())
    if (!name) return null
    return { vendor: 'nvidia', model: name, vram_mb: Number(mem) > 0 ? Number(mem) : null, driver: driver && /^\d/.test(driver) ? driver : null }
  }).filter(Boolean)
}

/** Pure: the plain `nvidia-smi` header → "12.8" or null — the driver's CUDA version lives nowhere else. */
export function parseNvidiaSmiCuda(text) {
  const m = /CUDA Version\s*:\s*(\d+\.\d+)/i.exec(String(text ?? ''))
  return m ? m[1] : null
}

/** Pure: `Get-CimInstance Win32_VideoController | ConvertTo-Json` (object or array) → gpus without a CUDA version. */
export function parseVideoControllers(json) {
  let rows
  try { rows = JSON.parse(String(json ?? '')) } catch { return [] }
  if (!rows) return []
  if (!Array.isArray(rows)) rows = [rows]
  return rows.map((r) => {
    const name = r?.Name ?? r?.name
    if (!name || /microsoft basic|remote display|virtual|parsec|idd/i.test(name)) return null
    const ram = Number(r.AdapterRAM ?? 0)
    // AdapterRAM is a uint32: anything at or over 4 GB is clipped and therefore unknown
    return { vendor: vendorOf(name), model: String(name), vram_mb: ram > 0 && ram < 4293918720 ? Math.floor(ram / 1048576) : null, driver: r.DriverVersion ? String(r.DriverVersion) : null }
  }).filter(Boolean)
}

/** Pure: gpus + cuda → the heartbeat block (the first GPU speaks for the machine; count says how many). */
export function gpuBlock(gpus, cuda = null) {
  if (!gpus?.length) return { ...NO_GPU }
  const g = gpus[0]
  return { vendor: g.vendor, model: g.model, vram_mb: g.vram_mb ?? null, cuda: g.vendor === 'nvidia' ? cuda : null, driver: g.driver ?? null, count: gpus.length }
}

/** Pure: "NVIDIA GeForce RTX 5070 Ti · 16 GB · CUDA 12.8 · driver 572.16", or null without a GPU. */
export function describeGpu(gpu) {
  if (!gpu || !gpu.model) return null
  const parts = [gpu.model]
  if (gpu.vram_mb) parts.push(`${(gpu.vram_mb / 1024).toFixed(gpu.vram_mb % 1024 ? 1 : 0)} GB`)
  if (gpu.cuda) parts.push(`CUDA ${gpu.cuda}`)
  else if (gpu.vendor === 'nvidia') parts.push('no CUDA driver found')
  if (gpu.driver) parts.push(`driver ${gpu.driver}`)
  if (gpu.count > 1) parts.push(`×${gpu.count}`)
  return parts.join(' · ')
}

/**
 * Pure: what the local page shows for the two boxes, by executor kind and detection.
 *   native, no GPU  → both boxes hidden, one grey line
 *   native, GPU     → the GPU box shown (enabled), the network box hidden, a grey line about network
 *   container       → the GPU box shown but disabled without a GPU ("No GPU on this machine"), the network box shown
 */
export function gpuPageLines({ native, gpu, gpuPackages = null }) {
  const has = !!(gpu && gpu.vendor === 'nvidia' && gpu.cuda)
  if (native && !has) return { gpu_box: false, net_box: false, line: gpu?.model && gpu.vendor !== 'nvidia' ? `GPU and network jobs: Linux container nodes only (${gpu.model} has no CUDA)` : gpu?.model ? `GPU and network jobs: Linux container nodes only (${gpu.model}: no CUDA driver found)` : 'GPU and network jobs: Linux container nodes only' }
  if (native) return { gpu_box: true, net_box: false, line: 'Network jobs: Linux container nodes only', gpu_note: describeGpu(gpu) + (gpuPackages ? ` · ${gpuPackages}` : '') }
  if (!gpu?.model) return { gpu_box: true, gpu_disabled: true, net_box: true, line: 'No GPU on this machine', gpu_note: '' }
  return { gpu_box: true, gpu_disabled: false, net_box: true, line: '', gpu_note: describeGpu(gpu) }
}

/* ───────────── the sandbox side: which folders hold the driver, and who may read them ───────────── */

/**
 * Where the NVIDIA user-mode driver lives on Windows. nvcuda.dll in System32 is a thin loader; the real nvcuda64.dll,
 * nvml.dll and the compiler live in the driver package under DriverStore\FileRepository\nv_dispi.inf_amd64_<hash>\
 * (one folder per installed driver version; the newest wins). `readdir`/`exists` are injectable for tests.
 */
export function nvidiaDriverDirs({ systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', readdir = readdirSync, exists = existsSync } = {}) {
  const repo = win32.join(systemRoot, 'System32', 'DriverStore', 'FileRepository')
  let names = []
  try { names = readdir(repo) } catch { return [] }
  return names.filter((n) => /^nv.*\.inf_amd64_[0-9a-f]+$/i.test(n)).map((n) => win32.join(repo, n)).filter((d) => exists(win32.join(d, 'nvcuda64.dll')) || exists(win32.join(d, 'nvml.dll')))
}

/** Pure: `icacls <path>` → does ALL APPLICATION PACKAGES (S-1-15-2-1) hold read (R, RX or F) here? */
export function parseIcacls(text) {
  const entries = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(?:\S.*?\s)?\s*([^:\n]+?):\s*((?:\([A-Z,]*\))+)\s*$/.exec(line.trim())
    if (!m) continue
    entries.push({ who: m[1].trim(), rights: m[2] })
  }
  const app = entries.filter((e) => /ALL APPLICATION PACKAGES|S-1-15-2-1\b|ALLE ANWENDUNGSPAKETE|TOUS LES PACKAGES/i.test(e.who))
  const read = app.some((e) => /\((?:F|RX|R|M)\)/.test(e.rights) || /\([^)]*\bRD\b[^)]*\)/.test(e.rights) || /\([^)]*\bGR\b[^)]*\)/.test(e.rights))
  return { app_packages_read: read, app_packages: app.map((e) => e.rights), entries: entries.length }
}

/* ───────────── the only function that runs anything ───────────── */

/** nvidia-smi on PATH, in System32 (the driver puts it there) or the legacy NVSMI folder. */
export function nvidiaSmiCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
    return ['nvidia-smi', win32.join(root, 'System32', 'nvidia-smi.exe'), win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')]
  }
  if (platform === 'darwin') return []   // no NVIDIA driver exists for modern macOS
  return ['nvidia-smi', '/usr/bin/nvidia-smi']
}

/**
 * Detect once. Returns { gpu, gpus, source: 'nvidia-smi' | 'win32_videocontroller' | 'none', reasons[] }.
 * Never throws; a machine without a GPU answers { gpu: NO_GPU } in well under a second.
 */
export async function detectGpu({ platform = process.platform, env = process.env, exec = execFileP, exists = existsSync, log = () => {} } = {}) {
  const reasons = []
  const run = async (bin, args, timeout = 15_000) => { const { stdout } = await exec(bin, args, { timeout, encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true }); return stdout }
  for (const bin of nvidiaSmiCandidates({ platform, env })) {
    if (bin.includes('\\') || bin.includes('/')) { if (!exists(bin)) continue }
    try {
      const gpus = parseNvidiaSmiCsv(await run(bin, NVIDIA_SMI_QUERY))
      if (!gpus.length) { reasons.push(`${bin}: no NVIDIA GPU listed`); break }
      let cuda = null
      try { cuda = parseNvidiaSmiCuda(await run(bin, [])) } catch (e) { reasons.push(`${bin} header: ${String(e.message).split('\n')[0]}`) }
      if (!cuda) reasons.push(`${bin}: the header names no CUDA version (driver too old for CUDA?)`)
      const gpu = gpuBlock(gpus, cuda)
      log(`gpu: ${describeGpu(gpu)} (nvidia-smi)`)
      return { gpu, gpus, source: 'nvidia-smi', reasons }
    } catch (e) {
      const msg = String(e.code === 'ENOENT' ? 'not found' : e.message).split('\n')[0]
      reasons.push(`${bin}: ${msg}`)
      if (e.code !== 'ENOENT') break   // it exists but failed (driver not loaded): no point trying another copy
    }
  }
  if (platform === 'win32') {
    try {
      const json = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress'], 30_000)
      const gpus = parseVideoControllers(json)
      if (gpus.length) {
        const gpu = gpuBlock(gpus, null)
        if (gpu.vendor === 'nvidia') reasons.push('NVIDIA adapter present but nvidia-smi is missing: the display driver is not installed the normal way, no CUDA')
        log(`gpu: ${describeGpu(gpu)} (Win32_VideoController)`)
        return { gpu, gpus, source: 'win32_videocontroller', reasons }
      }
      reasons.push('Win32_VideoController lists no discrete adapter')
    } catch (e) { reasons.push(`Win32_VideoController: ${String(e.message).split('\n')[0]}`) }
  }
  log(`gpu: none${reasons.length ? ` (${reasons[0]})` : ''}`)
  return { gpu: { ...NO_GPU }, gpus: [], source: 'none', reasons }
}
