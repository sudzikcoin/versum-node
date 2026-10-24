/**
 * What the node measures about a running container, as evidence beside the hub's clock:
 *   cpuSeconds  cumulative CPU time from the container's cgroup (cpu.stat usage_usec), cgroup v2
 *   wall        from the moment `run` was spawned to the moment the container exited
 * The hub bills on its own clock (lease → finish, capped at the time limit); these figures are reported,
 * logged locally for the owner, and used by the stall watchdog («is it still doing anything?»).
 */
import { readFileSync, existsSync } from 'node:fs'

/** Pure: usage_usec from a cpu.stat body, in seconds. */
export function parseCpuStat(text) {
  const m = /usage_usec\s+(\d+)/.exec(String(text))
  return m ? Number(m[1]) / 1e6 : null
}

/** Candidate cgroup v2 cpu.stat paths for a container id, by runtime. The first that exists wins. */
export function cpuStatCandidates(runtime, id, cgroupPath = null) {
  const c = []
  if (cgroupPath) c.push(`/sys/fs/cgroup${cgroupPath}/cpu.stat`)
  if (runtime === 'docker') c.push(`/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat`, `/sys/fs/cgroup/docker/${id}/cpu.stat`)
  if (runtime === 'podman') c.push(`/sys/fs/cgroup/machine.slice/libpod-${id}.scope/cpu.stat`)
  return c
}

export function makeMeter({ rt, runtime, name }) {
  let id = null, cgroupPath = null, statPath = null
  return {
    /** Resolve the container id (and podman's cgroup path) once it exists. */
    async resolve() {
      if (statPath) return statPath
      try {
        if (!id) id = (await rt.run(['inspect', '-f', '{{.Id}}', name], { timeoutMs: 5000 })) || null
        if (!id) return null
        if (runtime === 'podman' && !cgroupPath) cgroupPath = (await rt.run(['inspect', '-f', '{{.State.CgroupPath}}', name], { timeoutMs: 5000 })) || null
      } catch { return null }
      statPath = cpuStatCandidates(runtime, id, cgroupPath).find((p) => existsSync(p)) ?? null
      return statPath
    },
    /** Cumulative CPU seconds right now, or null when the cgroup cannot be read (reported as null, never guessed). */
    async cpuSeconds() {
      const p = await this.resolve()
      if (!p) return null
      try { return parseCpuStat(readFileSync(p, 'utf8')) } catch { return null }
    },
    get id() { return id },
  }
}
