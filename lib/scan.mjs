/**
 * The scanner: what this machine has. Reads /proc, /sys, `df`, `nvidia-smi` / `rocm-smi` and the container
 * runtime. It never walks the disk, never opens a file outside /proc, /sys and the node's own home, and the
 * `detected` block it returns holds only the figures below — no paths, no user names, no environment.
 * Every parser is pure (text in, numbers out) so it can be tested on fixtures from other machines.
 */
import { readFileSync, existsSync, readdirSync, statfsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
const execFileP = promisify(execFile)

export const NODE_VERSION = '0.4.2'

export function parseCpuInfo(text) {
  const lines = String(text).split('\n')
  const model = (lines.find((l) => /^model name\s*:/i.test(l)) ?? '').split(':').slice(1).join(':').trim() || null
  const cores = lines.filter((l) => /^processor\s*:/i.test(l)).length || null
  return { model, cores }
}

export function parseMemInfo(text) {
  const kb = (key) => { const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text)); return m ? Number(m[1]) : null }
  const total = kb('MemTotal'), avail = kb('MemAvailable')
  return { ram_mb: total === null ? null : Math.floor(total / 1024), ram_available_mb: avail === null ? null : Math.floor(avail / 1024) }
}

/** nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits → one line per GPU "NVIDIA RTX 3060, 12288" */
export function parseNvidiaSmi(text) {
  const gpus = String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, mem] = l.split(',').map((s) => s.trim()); return { name, vram_mb: Number(mem) || null } })
  if (!gpus.length) return { gpu_count: 0, gpu_model: null, gpu_vram_mb: null, gpu_vendor: null }
  return { gpu_count: gpus.length, gpu_model: gpus[0].name, gpu_vram_mb: gpus[0].vram_mb, gpu_vendor: 'nvidia' }
}

/** rocm-smi --showproductname --showmeminfo vram --json → best effort. */
export function parseRocmSmi(text) {
  try {
    const j = JSON.parse(text)
    const cards = Object.keys(j).filter((k) => /^card\d+$/.test(k))
    if (!cards.length) return { gpu_count: 0, gpu_model: null, gpu_vram_mb: null, gpu_vendor: null }
    const c = j[cards[0]]
    const name = c['Card series'] ?? c['Card SKU'] ?? c['Card model'] ?? 'AMD GPU'
    const bytes = Number(c['VRAM Total Memory (B)'] ?? 0)
    return { gpu_count: cards.length, gpu_model: name, gpu_vram_mb: bytes ? Math.floor(bytes / 1048576) : null, gpu_vendor: 'amd' }
  } catch { return { gpu_count: 0, gpu_model: null, gpu_vram_mb: null, gpu_vendor: null } }
}

/** /sys/class/net/<iface>/{type,wireless} + the default route's interface name → ethernet | wifi | cellular | unknown. */
export function classifyInterface(name, { wireless = false } = {}) {
  if (!name) return 'unknown'
  if (wireless || /^(wl|wifi|ath|wlan)/.test(name)) return 'wifi'
  if (/^(wwan|ppp|rmnet|usb0|cdc-wdm)/.test(name)) return 'cellular'
  if (/^(en|eth|em|eno|ens|enp)/.test(name)) return 'ethernet'
  return 'unknown'
}

/** /proc/net/route: the interface of the default route (destination 00000000). */
export function defaultRouteInterface(text) {
  for (const line of String(text).split('\n').slice(1)) { const f = line.trim().split(/\s+/); if (f[1] === '00000000') return f[0] }
  return null
}

function readSafe(p) { try { return readFileSync(p, 'utf8') } catch { return '' } }
async function tryExec(bin, args, timeoutMs = 10_000) { try { const { stdout } = await execFileP(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1 << 20 }); return stdout } catch { return null } }

/** Free space, in MB, of the filesystem the jobs directory lives on. */
export function diskFreeMb(dir) {
  try { const s = statfsSync(dir); return Math.floor(Number(s.bavail) * Number(s.bsize) / 1048576) } catch { return null }
}

/**
 * The whole scan. `runtime` is the detected runtime description (from runtime.mjs) or null.
 * Returns the `resources` object the hub accepts on PUT /me/node and in the heartbeat.
 */
export async function scan({ jobsDir, runtime = null } = {}) {
  const linux = process.platform === 'linux'
  const cpu = linux ? parseCpuInfo(readSafe('/proc/cpuinfo')) : { model: os.cpus()[0]?.model ?? null, cores: os.cpus().length || null }
  const mem = linux ? parseMemInfo(readSafe('/proc/meminfo')) : { ram_mb: Math.floor(os.totalmem() / 1048576), ram_available_mb: Math.floor(os.freemem() / 1048576) }
  let gpu = { gpu_count: 0, gpu_model: null, gpu_vram_mb: null, gpu_vendor: null }
  const nv = await tryExec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  if (nv) gpu = parseNvidiaSmi(nv)
  else { const rocm = await tryExec('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json']); if (rocm) gpu = parseRocmSmi(rocm) }
  let connection_type = 'unknown'
  if (linux) {
    const iface = defaultRouteInterface(readSafe('/proc/net/route'))
    connection_type = classifyInterface(iface, { wireless: !!iface && existsSync(`/sys/class/net/${iface}/wireless`) })
  }
  const detected = {
    platform: process.platform, arch: process.arch, kernel: os.release(),
    cpu_model: cpu.model, cores: cpu.cores ?? os.cpus().length, ram_mb: mem.ram_mb, ram_available_mb: mem.ram_available_mb,
    gpu, runtime: runtime ? { kind: runtime.kind ?? 'container', name: runtime.name, version: runtime.version, rootless: runtime.rootless, sandbox: runtime.sandbox ?? null } : null,
    nvidia_container_toolkit: linux ? (await tryExec('nvidia-ctk', ['--version'])) !== null : false,
    scanned_at: new Date().toISOString(),
  }
  return {
    cpu_cores: cpu.cores ?? os.cpus().length ?? null,
    cpu_model: cpu.model,
    cpu_arch: process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch,
    ram_mb: mem.ram_mb,
    disk_free_mb: jobsDir ? diskFreeMb(jobsDir) : null,
    gpu_count: gpu.gpu_count, gpu_model: gpu.gpu_model, gpu_vram_mb: gpu.gpu_vram_mb,
    os: process.platform,
    container_runtime: runtime?.kind === 'container' && runtime.name ? runtime.name : 'none',
    // v0.4.0: what kind of executor this is — the scheduler offers container jobs only to container_docker nodes
    executor_kind: runtime?.kind === 'native' ? 'script_native' : 'container_docker',
    connection_type,
    downlink_mbps: null, uplink_mbps: null,   // measured later by a speed probe the owner can run; never guessed
    node_version: NODE_VERSION,
    detected,
  }
}

/** A one-screen rendering for `versum-node scan`. */
export function renderScan(r) {
  const gb = (mb) => (mb == null ? '?' : (mb / 1024).toFixed(1) + ' GB')
  return [
    `CPU      ${r.cpu_cores ?? '?'} cores · ${r.cpu_model ?? 'unknown'} · ${r.cpu_arch}`,
    `RAM      ${gb(r.ram_mb)}`,
    `Disk     ${gb(r.disk_free_mb)} free for jobs`,
    `GPU      ${r.gpu_count ? `${r.gpu_count} × ${r.gpu_model} (${gb(r.gpu_vram_mb)})${r.detected.nvidia_container_toolkit ? '' : ' — nvidia-container-toolkit not found, GPU jobs unavailable'}` : 'none'}`,
    `Network  ${r.connection_type}`,
    `Runtime  ${r.executor_kind === 'script_native' ? `built-in sandbox (${r.detected.runtime?.sandbox === 'appcontainer' ? 'Windows AppContainer' : 'macOS Seatbelt'}) · Python ${r.detected.runtime?.version ?? '?'} · script jobs only` : `${r.container_runtime}${r.detected.runtime ? ` ${r.detected.runtime.version} ${r.detected.runtime.rootless ? 'rootless' : 'ROOTFUL'}` : ''}`}`,
    `OS       ${r.os} ${r.detected.kernel}`,
  ].join('\n')
}
