/**
 * The local status page: http://127.0.0.1:3311/ — loopback only, JSON, no key in it. `GET /health` answers
 * 200 when the node heartbeated the hub within three intervals, 503 otherwise, so a systemd or uptime check
 * can read it. This is the whole local UI in v1; a browser page over the same JSON comes later.
 */
import http from 'node:http'

export function startHealthServer({ port, state, log = () => {}, intervalSeconds = 30 }) {
  const server = http.createServer((req, res) => {
    const s = state()
    const age = s.lastBeatAt ? (Date.now() - Date.parse(s.lastBeatAt)) / 1000 : Infinity
    const ok = s.lastBeatOk === true && age <= intervalSeconds * 3
    const body = { ok, status: s.draining ? 'draining' : s.running.length ? 'working' : ok ? 'idle' : 'offline', hub: s.hub, started_at: s.startedAt, last_heartbeat_at: s.lastBeatAt, last_error: s.lastError, running: s.running, finished: s.finished.slice(-10), leases: s.leases, refused: s.refused, scan: s.scan && { cpu_cores: s.scan.cpu_cores, ram_mb: s.scan.ram_mb, disk_free_mb: s.scan.disk_free_mb, gpu_count: s.scan.gpu_count, container_runtime: s.scan.container_runtime, connection_type: s.scan.connection_type } }
    res.writeHead(req.url === '/health' && !ok ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2))
  })
  server.on('error', (e) => log(`status page not started: ${e.message}`))
  server.listen(port, '127.0.0.1', () => log(`status page on http://127.0.0.1:${port}/`))
  return server
}
