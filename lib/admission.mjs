/**
 * The node runs at most `limit` attempts at once (share.max_parallel_jobs). One gate every start goes through.
 * Pure: no timers, no hub. (From versum-worker's lib/admission.mjs, without per-capability limits.)
 */
export function createAdmission({ limit = 1 } = {}) {
  const running = new Map()   // attempt_id → { since, job_id }
  return {
    get limit() { return limit },
    set limit(n) { limit = Math.max(1, Math.min(32, Number(n) || 1)) },
    canStart() { return running.size < limit },
    start(id, info = {}) {
      if (running.has(id)) throw new Error(`${id} is already running`)
      if (!this.canStart()) throw new Error(`limit: ${running.size}/${limit} running`)
      running.set(id, { since: Date.now(), ...info })
    },
    end(id) { running.delete(id) },
    has(id) { return running.has(id) },
    running() { return [...running.entries()].map(([id, r]) => ({ id, ...r })) },
    get size() { return running.size },
  }
}
