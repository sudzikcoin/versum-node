/** One line per event, UTC timestamp first, to stderr. Never a key, never a path inside a job, never job payload. */
export function makeLog(prefix = 'node') {
  return (msg, extra) => {
    const line = `${new Date().toISOString()} [${prefix}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`
    process.stderr.write(line + '\n')
  }
}
export const log = makeLog()
