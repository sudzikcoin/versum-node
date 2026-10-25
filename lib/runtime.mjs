/**
 * Which executor runs jobs on this machine, and one place that spawns it.
 *
 *   native     Windows and macOS (v0.4.0): the embedded Python inside the OS sandbox — lib/native.mjs. Found
 *              first on those platforms when the Python tree is beside the node. Script jobs only.
 *   container  Linux: Podman first (daemonless, rootless by default), Docker second. Where Docker Desktop or
 *              OrbStack exist on a Mac/PC they still work (the daemon is in a VM), and `runtime: docker` in the
 *              config (or VERSUM_NODE_RUNTIME=docker) prefers them — the advanced path for GPU work later.
 *
 * Rootless is the point on Linux: the node must never be a member of the `docker` group (root-equivalent on the
 * host). A rootful Docker is not used until the owner allowed it once on the local page.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { detectNative, createNativeExecutor } from './native.mjs'
import { createContainerExecutor } from './container.mjs'
const execFileP = promisify(execFile)

export async function which(bin) {
  try { const { stdout } = await execFileP(process.platform === 'win32' ? 'where' : 'which', [bin]); return stdout.trim().split('\n')[0] || null } catch { return null }
}

export function makeRuntime(bin) {
  return {
    bin,
    /** Run a runtime command, capture stdout; throws with stderr on a non-zero exit. */
    async run(args, { timeoutMs = 60_000, maxBuffer = 16 << 20 } = {}) {
      try { const { stdout } = await execFileP(bin, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' }); return stdout.trim() }
      catch (e) { const err = new Error(`${bin} ${args.slice(0, 2).join(' ')}: ${String(e.stderr ?? e.message).trim().split('\n').pop()}`); err.cause = e; throw err }
    },
    /** Spawn a long-running runtime command (the job itself) and hand back the child. */
    spawn(args, opts = {}) { return spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }) },
  }
}

/** Pure: which family to look for first. Windows/macOS → native unless the owner named a container runtime. */
export function runtimeOrder(preferred, platform = process.platform) {
  if (preferred === 'native') return ['native']
  if (preferred === 'podman' || preferred === 'docker') return [preferred]
  return platform === 'win32' || platform === 'darwin' ? ['native', 'docker', 'podman'] : ['podman', 'docker']
}

/**
 * Find an executor and describe it. Returns { ok, kind, name, version, rootless, reasons[], rt?, python?, sandbox? }.
 * A container runtime that cannot answer `info` (daemon down, socket unreadable) is not ok.
 */
export async function detectRuntime(preferred = null, { allowRootful = false, appRoot = null, env = process.env } = {}) {
  const reasons = []
  for (const name of runtimeOrder(env.VERSUM_NODE_RUNTIME || preferred)) {
    if (name === 'native') {
      const n = await detectNative({ appRoot, env })
      if (n.ok) return n
      reasons.push(...n.reasons.map((r) => `native: ${r}`))
      continue
    }
    const bin = await which(name)
    if (!bin) { reasons.push(`${name}: not installed`); continue }
    const rt = makeRuntime(bin)
    let version = null, rootless = null
    try {
      if (name === 'podman') {
        const info = JSON.parse(await rt.run(['info', '--format', 'json'], { timeoutMs: 30_000 }))
        version = info?.version?.Version ?? null
        rootless = info?.host?.security?.rootless === true
      } else {
        const out = await rt.run(['info', '--format', '{{.ServerVersion}} {{json .SecurityOptions}}'], { timeoutMs: 30_000 })
        const [v, ...rest] = out.split(' ')
        version = v || null
        rootless = /rootless/.test(rest.join(' '))
      }
    } catch (e) { reasons.push(`${name}: ${e.message}`); continue }
    // Docker Desktop / OrbStack on macOS and Windows run the daemon inside a VM: a container escape lands in the VM,
    // not on the host. That is the isolation rootless gives on Linux, so it counts as rootless here.
    if (name === 'docker' && !rootless && (process.platform === 'darwin' || process.platform === 'win32')) rootless = true
    // Stage 2a: consent comes from the local page (config.allow_rootful), the env var stays for scripts.
    allowRootful = allowRootful || env.VERSUM_NODE_ALLOW_ROOTFUL === '1'
    if (!rootless && !allowRootful) reasons.push(`${name} ${version} runs ROOTFUL: a container escape would be root on this machine. Install rootless Podman (recommended) or rootless Docker — or, if you accept the risk for this computer, allow it once on the local page http://127.0.0.1:3311/.`)
    return { ok: rootless || allowRootful, kind: 'container', bin, name, version, rootless, reasons, rt, sandbox: null, python: null }
  }
  return { ok: false, kind: null, bin: null, name: null, version: null, rootless: null, reasons, rt: null, sandbox: null, python: null }
}

/** The executor the runner drives, from a detectRuntime() result. */
export function makeExecutor(rtd, { home, egressDir, log = () => {}, pylib = null }) {
  if (!rtd?.ok) throw new Error('no usable runtime')
  if (rtd.kind === 'native') return createNativeExecutor({ python: rtd.python, helper: rtd.helper, sandbox: rtd.sandbox, home, log , pylib })
  return createContainerExecutor({ rt: rtd.rt, runtime: rtd.name, egressDir, log })
}

/** Kill and remove every leftover job container from a previous run of the node (container runtimes only). */
export async function reapContainers(rt, log = () => {}) {
  if (!rt) return 0
  let ids = []
  try { ids = (await rt.run(['ps', '-aq', '--filter', 'label=versum.job=1'])).split('\n').filter(Boolean) } catch { return 0 }
  if (ids.length) { log(`reaping ${ids.length} leftover job container(s)`); await rt.run(['rm', '-f', ...ids]).catch(() => {}) }
  return ids.length
}

/** One line for the log and the local page: what will run jobs here. */
export function describeRuntime(rtd) {
  if (!rtd?.ok) return 'no runtime'
  if (rtd.kind === 'native') return `built-in sandbox (${rtd.sandbox === 'appcontainer' ? 'Windows AppContainer' : 'macOS Seatbelt'}) · Python ${rtd.version} · script jobs only`
  return `${rtd.name} ${rtd.version} ${rtd.rootless ? 'rootless' : 'ROOTFUL (allowed by the owner)'}`
}
