/**
 * The only way a job reaches the internet, and only when the job asked AND the owner allowed it:
 * the job container sits on an --internal network with no route out; a per-job tinyproxy sidecar with
 * two legs (internal + the runtime's default bridge) forwards CONNECT to 443/80 and refuses the LAN —
 * localhost, RFC 1918 and link-local literals, .local/.internal names, cloud metadata — by a deny filter
 * baked into the image. Every host the job reached is in the proxy's log, kept beside the attempt's own
 * log for the owner. The proxy dies with the job.
 *
 * Known gap (documented in docs/threat-model.md): a public hostname that resolves to a LAN address is
 * not caught by a name filter. v1 mitigation is the default: network off.
 * (From versum-worker's lib/egress.mjs, reduced to the one case the node needs.)
 */
import { join } from 'node:path'

export const EGRESS_NET = 'versum-egress-int'
export const PROXY_IMAGE = 'localhost/versum-egress-proxy:1'

export async function ensureEgressNetwork(rt) {
  try { await rt.run(['network', 'inspect', EGRESS_NET]) } catch { await rt.run(['network', 'create', '--internal', EGRESS_NET]) }
}

export async function ensureProxyImage(rt, egressDir, log = () => {}) {
  try { await rt.run(['image', 'inspect', PROXY_IMAGE]); return } catch {}
  log('egress: building the proxy image (tinyproxy on alpine)')
  await rt.run(['build', '-q', '-t', PROXY_IMAGE, egressDir], { timeoutMs: 300_000 })
}

/** The runtime's default (routable) network, the proxy's second leg. */
export function defaultNetworkName(runtime) { return runtime === 'podman' ? 'podman' : 'bridge' }

export async function startJobProxy(rt, runtime, attemptId, { egressDir, log = () => {} }) {
  await ensureEgressNetwork(rt)
  await ensureProxyImage(rt, egressDir, log)
  const name = `versum-egress-${attemptId}`.slice(0, 60)
  await rt.run(['rm', '-f', name]).catch(() => {})
  await rt.run(['run', '-d', '--name', name, '--label', 'versum.job=1', '--network', EGRESS_NET,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '64',
    PROXY_IMAGE])
  await rt.run(['network', 'connect', defaultNetworkName(runtime), name])
  log(`egress: proxy ${name} up — the job may reach the internet on 443/80 through it; every host is logged`)
  return { name, proxy: name }
}

/** The hosts the job reached (one line per CONNECT/request), capped. */
export async function proxyLog(rt, proxy, maxBytes = 1 << 20) {
  if (!proxy) return ''
  try { const out = await rt.run(['logs', proxy.name], { maxBuffer: 64 << 20 }); return out.length > maxBytes ? out.slice(-maxBytes) : out } catch (e) { return `(proxy log unavailable: ${e.message})` }
}

export async function stopJobProxy(rt, proxy) {
  if (!proxy) return
  await rt.run(['rm', '-f', proxy.name]).catch(() => {})
}

export const egressDirOf = (root) => join(root, 'egress')
