/**
 * The node's one connection to the hub: outbound HTTPS with the node key as a bearer token. Nothing listens.
 * Paths are documented in protocol/README.md; the ones under /jobs and /attempts are the job protocol the hub
 * implements in its block 4, the rest exist today (/me, /me/heartbeat, /me/node).
 * Retries only what is safe to retry (timeouts, connection errors, 502/503/504), with pauses; a 4xx is the
 * hub's answer and is thrown as ApiError { status, code, message }.
 * (From versum-worker's lib/api.mjs.)
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message || code); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details }
}
const RETRY_PAUSES = [1000, 3000, 8000]
const retriable = (e) => e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504 || e.code === 'timeout' || e.code === 'network')

export const PROTOCOL_HEADER = 'x-versum-protocol'
export const NODE_PROTOCOL = '2.1.0'   // 2.1: resources.executor_kind (an older hub ignores it)

export function createHub({ baseUrl, key, log = () => {}, fetchImpl = fetch, userAgent = 'versum-node' }) {
  const base = String(baseUrl).replace(/\/$/, '') + '/api/agent/v1'
  async function once(method, path, body, { timeoutMs = 30_000, raw = null } = {}) {
    if (!key) throw new ApiError(0, 'no_key', 'the node is not paired: run `versum-node pair <key>`')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const headers = { authorization: `Bearer ${key}`, 'user-agent': userAgent, [PROTOCOL_HEADER]: NODE_PROTOCOL, ...(raw ? raw.headers : body !== undefined ? { 'content-type': 'application/json' } : {}) }
      const r = await fetchImpl(`${base}${path}`, { method, headers, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body), signal: ac.signal, ...(raw?.duplex ? { duplex: 'half' } : {}) })
      if (r.status === 204) return null
      const text = await r.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 300) } }
      if (!r.ok) throw new ApiError(r.status, json?.error?.code ?? 'http_error', json?.error?.message ?? text.slice(0, 300), json?.error?.details)
      return json
    } catch (e) {
      if (e instanceof ApiError) throw e
      throw new ApiError(0, e.name === 'AbortError' ? 'timeout' : 'network', e.message)
    } finally { clearTimeout(timer) }
  }
  async function call(method, path, body, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await once(method, path, body, opts) }
      catch (e) {
        if (!retriable(e) || attempt >= RETRY_PAUSES.length || opts.noRetry) throw e
        log(`hub ${method} ${path}: ${e.code} ${e.message} — retry in ${RETRY_PAUSES[attempt] / 1000} s`)
        await new Promise((r) => setTimeout(r, RETRY_PAUSES[attempt]))
      }
    }
  }
  return {
    base,
    me: () => call('GET', '/me'),
    heartbeat: (body) => call('POST', '/me/heartbeat', body, { noRetry: true }),
    getNode: () => call('GET', '/me/node'),
    setNode: (body) => call('PUT', '/me/node', body, { timeoutMs: 60_000 }),
    // 0.4.7: the relay for shared local models — long-poll calls, stream chunks back, finish with usage
    calls: ({ wait = 20 } = {}) => call('GET', `/me/calls?wait=${wait}`, undefined, { noRetry: true, timeoutMs: (wait + 15) * 1000 }),
    callChunks: (id, body) => call('POST', `/me/calls/${id}/chunks`, body, { noRetry: true }),
    callFinish: (id, body) => call('POST', `/me/calls/${id}/finish`, body, { timeoutMs: 120_000 }),
    // 0.4.8: a relayed call that produced files (an image, an SRT) posts them before it finishes; the hub puts them
    // in the job's output store, so the buyer downloads them exactly as a machine job's outputs.
    callFiles: (id, files) => call('POST', `/me/calls/${id}/files`, { files }, { timeoutMs: 300_000 }),
    /** Ask for work. 204 → null; 200 → a manifest (validated by the caller, never trusted as is). */
    lease: (body) => call('POST', '/jobs/lease', body, { noRetry: true }),
    attemptHeartbeat: (id, body) => call('POST', `/attempts/${id}/heartbeat`, body, { noRetry: true }),
    finish: (id, body) => call('POST', `/attempts/${id}/finish`, body, { timeoutMs: 60_000 }),
    release: (id, body) => call('POST', `/attempts/${id}/release`, body),
    /** One output file, streamed as the request body (the artefact door's shape: x-file-name + content-type). */
    async uploadOutput(id, filePath, { name, contentType = 'application/octet-stream' }) {
      const size = statSync(filePath).size
      const body = Readable.toWeb(createReadStream(filePath))
      return call('POST', `/attempts/${id}/outputs/stream`, undefined, { timeoutMs: 600_000, raw: { body, duplex: true, headers: { 'content-type': contentType, 'x-file-name': encodeURIComponent(name), 'content-length': String(size) } } })
    },
    /** A signed input URL → file, refusing past maxBytes mid-stream and checking sha256 when given. Plain fetch: inputs are not on the hub's key. */
    async download(url, dest, { maxBytes, sha256 = null, timeoutMs = 900_000 } = {}) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const r = await fetchImpl(url, { signal: ac.signal, headers: { 'user-agent': userAgent } })
        if (!r.ok || !r.body) throw new ApiError(r.status, 'input_fetch_failed', `input ${r.status}`)
        let size = 0
        const hash = createHash('sha256')
        const guard = new Transform({ transform(chunk, _enc, cb) { size += chunk.length; if (maxBytes && size > maxBytes) return cb(new ApiError(0, 'input_too_large', `input exceeds ${maxBytes} bytes`)); hash.update(chunk); cb(null, chunk) } })
        await pipeline(Readable.fromWeb(r.body), guard, createWriteStream(dest, { mode: 0o600 }))
        const digest = hash.digest('hex')
        if (sha256 && digest !== sha256) throw new ApiError(0, 'input_checksum_mismatch', `sha256 ${digest.slice(0, 12)}… ≠ ${sha256.slice(0, 12)}…`)
        return { size, sha256: digest }
      } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(0, e.name === 'AbortError' ? 'timeout' : 'network', e.message) }
      finally { clearTimeout(timer) }
    },
  }
}
