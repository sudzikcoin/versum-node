/**
 * One line per event, UTC timestamp first, to stderr. Never a key, never a path inside a job, never job payload.
 * The last LOG_KEEP lines are kept in memory for the local page's log tail (stage 2d) — same rule, same lines.
 */
export const LOG_KEEP = 300
const recent = []

export function makeLog(prefix = 'node') {
  return (msg, extra) => {
    const line = `${new Date().toISOString()} [${prefix}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`
    process.stderr.write(line + '\n')
    recent.push(line); if (recent.length > LOG_KEEP) recent.splice(0, recent.length - LOG_KEEP)
  }
}
/** The tail the local page shows: newest last, at most LOG_KEEP lines. */
export function recentLog(n = LOG_KEEP) { return recent.slice(-Math.max(1, Math.min(n, LOG_KEEP))) }
export const log = makeLog()
