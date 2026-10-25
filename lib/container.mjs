/**
 * The container executor (Linux: rootless Podman/Docker; Docker Desktop/OrbStack where the owner has them):
 * one attempt = one fresh container with the posture containerArgs() fixes, pulled by digest, a per-job proxy
 * only when the job asked AND the owner allowed, cpu seconds from the cgroup. The runner (runner.mjs) drives it
 * through the same four calls the native executor answers: prepare / start / cleanup / egressLog.
 * (The run part of the 0.3 runner, unchanged in substance.)
 */
import os from 'node:os'
import { containerArgs } from './manifest.mjs'
import { makeMeter } from './metering.mjs'
import { startJobProxy, stopJobProxy, proxyLog } from './egress.mjs'

export const DEFAULT_IMAGE_CAP_BYTES = 10 * 1024 ** 3

export function createContainerExecutor({ rt, runtime, egressDir, log = () => {}, imageCapBytes = DEFAULT_IMAGE_CAP_BYTES }) {
  const { uid, gid } = os.userInfo()
  return {
    kind: 'container', runtime,
    mountPath: () => '/job',
    /** Pull the image by digest; refuse one above the node's size cap. */
    async prepare({ manifest, note }) {
      note(`pulling ${manifest.image.split('@')[0]}@${manifest.image.split('@sha256:')[1].slice(0, 12)}…`)
      await rt.run(['pull', '-q', manifest.image], { timeoutMs: 900_000 })
      const size = Number(await rt.run(['image', 'inspect', '-f', '{{.Size}}', manifest.image]).catch(() => '0'))
      if (size > imageCapBytes) throw new Error(`image is ${Math.round(size / 1048576)} MB, above the node's cap of ${Math.round(imageCapBytes / 1048576)} MB`)
    },
    async start({ manifest, jobDir, share }) {
      const id = manifest.attempt_id
      const name = `versum-job-${id}`
      await rt.run(['rm', '-f', name]).catch(() => {})
      let proxy = null
      if (manifest.limits.network) {
        if (!share.allow_network) throw new Error('job needs network, owner has not allowed it')
        proxy = await startJobProxy(rt, runtime, id, { egressDir, log })
      }
      const args = containerArgs({ manifest, jobDir, name, uid, gid, runtime, network: proxy, gpu: share.gpu })
      log(`attempt ${id}: ${rt.bin} ${args.map((a) => (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) ? a.replace(/=.*$/, '=…') : a)).join(' ')}`)   // env values never reach the log
      const meter = makeMeter({ rt, runtime, name })
      const child = rt.spawn(args)
      child.containerName = name
      child.proxy = proxy
      let killed = null
      return {
        child,
        kill: (why) => { if (!killed) killed = why; rt.run(['kill', name]).catch(() => {}) },
        cpuSeconds: () => meter.cpuSeconds(),
        meta: () => null,
        get killedWhy() { return killed },
      }
    },
    async cleanup({ run }) {
      if (!run?.child) return
      await rt.run(['rm', '-f', run.child.containerName]).catch(() => {})
      await stopJobProxy(rt, run.child.proxy).catch(() => {})
    },
    async egressLog({ run }) { return run?.child?.proxy ? proxyLog(rt, run.child.proxy) : null },
    async ensureGrants() {},
  }
}
