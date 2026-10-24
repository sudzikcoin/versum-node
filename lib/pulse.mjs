/**
 * One pulse per running attempt on the node's own clock: a heartbeat to the hub at least every `intervalMs`
 * carrying the latest cpu seconds and a note, and a stall verdict when nothing moved for `stallMs` — then
 * `onStall` kills the container and the attempt is reported as failed («stalled»), so the piece can go to
 * another node instead of burning the buyer's minutes. Pure: `tick(now)` is the whole behaviour.
 * (Carried over from versum-worker's lib/pulse.mjs, minus the recipe passes.)
 */
export function createPulse({ send, status, onStall, intervalMs = 30_000, stallMs = 900_000, log = () => {} }) {
  let lastSent = null, stalled = false, started = null
  return {
    async tick(now = Date.now()) {
      if (started === null) started = now
      const s = status() ?? {}
      const progressAt = Math.max(s.progressAt ?? 0, started)
      if (!stalled && stallMs > 0 && now - progressAt > stallMs) {
        stalled = true
        const why = `no progress for ${Math.round((now - progressAt) / 1000)} s (limit ${Math.round(stallMs / 1000)} s)`
        log(`stall: ${why}`)
        try { await onStall?.(why) } catch (e) { log(`onStall failed: ${e.message}`) }
        return
      }
      if (lastSent === null ? now - started >= intervalMs : now - lastSent >= intervalMs) {
        lastSent = now
        try { await send({ cpu_seconds: s.cpuSeconds ?? null, wall_seconds: Math.round((now - started) / 1000), note: `${s.note ?? ''}`.slice(0, 200), progress_age_s: Math.round((now - progressAt) / 1000) }) }
        catch (e) { log(`pulse send failed: ${e.message}`) }
      }
    },
    get stalled() { return stalled },
  }
}

export function startPulse(opts) {
  const p = createPulse(opts)
  const timer = setInterval(() => { p.tick(Date.now()).catch(() => {}) }, Math.min(opts.intervalMs ?? 30_000, 10_000))
  return { stop: () => clearInterval(timer), get stalled() { return p.stalled }, tick: p.tick }
}
