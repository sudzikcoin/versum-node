/**
 * The container runtime: Podman first (daemonless, rootless by default), Docker second. Everything the node
 * does to a container goes through `rt.run(args)` so there is exactly one place that spawns it.
 *
 * Rootless is the point: the node must never be a member of the `docker` group (root-equivalent on the host).
 * `check()` says plainly which runtime was found, whether it runs rootless, and refuses to call the node
 * ready when it is rootful Docker unless the owner set VERSUM_NODE_ALLOW_ROOTFUL=1 and read the warning.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
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

/**
 * Find a runtime and describe it. Returns { ok, bin, name, version, rootless, reasons[] }.
 * A runtime that cannot run `hello` (daemon down, socket unreadable) is not ok.
 */
export async function detectRuntime(preferred = null) {
  const order = preferred ? [preferred] : ['podman', 'docker']
  const reasons = []
  for (const name of order) {
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
    const allowRootful = process.env.VERSUM_NODE_ALLOW_ROOTFUL === '1'
    if (!rootless && !allowRootful) reasons.push(`${name} ${version} runs ROOTFUL: a container escape would be root on this machine. Install rootless Podman (recommended) or rootless Docker, or set VERSUM_NODE_ALLOW_ROOTFUL=1 to accept the risk.`)
    return { ok: rootless || allowRootful, bin, name, version, rootless, reasons, rt }
  }
  return { ok: false, bin: null, name: null, version: null, rootless: null, reasons, rt: null }
}

/** Kill and remove every leftover job container from a previous run of the node. */
export async function reapContainers(rt, log = () => {}) {
  let ids = []
  try { ids = (await rt.run(['ps', '-aq', '--filter', 'label=versum.job=1'])).split('\n').filter(Boolean) } catch { return 0 }
  if (ids.length) { log(`reaping ${ids.length} leftover job container(s)`); await rt.run(['rm', '-f', ...ids]).catch(() => {}) }
  return ids.length
}
