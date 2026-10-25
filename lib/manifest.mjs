/**
 * The job manifest the hub hands a node on lease, and the ONLY way it becomes a container: the node
 * reads the fields below, refuses anything else, and builds the runtime argv itself. A manifest cannot
 * carry runtime flags, mounts, capabilities, devices or host paths — there is no field for them.
 *
 *   attempt_id, piece_id, job_id      ids (uuid)
 *   kind                              "python" | "container"
 *   image                             name@sha256:… — ALWAYS pinned by digest; an unpinned image is refused
 *   command                           argv inside the container (python: ["python", "/job/in/<script>"])
 *   env                               plain KEY=value the buyer set; keys [A-Z_][A-Z0-9_]*, ≤ 64 of them, ≤ 4 KB each
 *   args                              the piece's parameters → written to /job/piece.json
 *   limits                            { cpu_cores, ram_mb, disk_mb, gpu, network, time_limit_minutes }
 *   inputs                            [{ name, url, size_bytes, sha256? }] → /job/in/<name>
 *   price_per_minute_usd              the price snapshotted for this attempt (shown in the local log only)
 *
 * Pure: validateManifest() and containerArgs() touch no I/O.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]{1,128})?@sha256:[0-9a-f]{64}$/
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const RESERVED_ENV = new Set(['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])

export class ManifestError extends Error { constructor(msg) { super(msg); this.name = 'ManifestError' } }
const fail = (m) => { throw new ManifestError(m) }

export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest must be an object')
  for (const k of ['attempt_id', 'piece_id', 'job_id']) if (!UUID.test(String(m[k] ?? ''))) fail(`${k} must be a uuid`)
  if (m.kind !== 'python' && m.kind !== 'container') fail('kind must be python or container')
  if (typeof m.image !== 'string' || !IMAGE.test(m.image)) fail('image must be pinned by digest: name@sha256:<64 hex>')
  if (!Array.isArray(m.command) || !m.command.length || m.command.length > 64 || m.command.some((c) => typeof c !== 'string' || c.length > 4096 || c.includes('\0'))) fail('command must be a non-empty array of strings')
  const env = m.env ?? {}
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('env must be an object')
  const envEntries = Object.entries(env)
  if (envEntries.length > 64) fail('env: at most 64 variables')
  for (const [k, v] of envEntries) {
    if (!ENV_KEY.test(k)) fail(`env: bad key ${JSON.stringify(k)}`)
    if (RESERVED_ENV.has(k)) fail(`env: ${k} is reserved`)
    if (typeof v !== 'string' || v.length > 4096 || v.includes('\0')) fail(`env: ${k} must be a string of at most 4096 chars`)
  }
  const L = m.limits
  if (!L || typeof L !== 'object') fail('limits required')
  const int = (k, min, max) => { const n = Number(L[k]); if (!Number.isInteger(n) || n < min || n > max) fail(`limits.${k} must be a whole number ${min}–${max}`); return n }
  const limits = {
    cpu_cores: int('cpu_cores', 1, 4096),
    ram_mb: int('ram_mb', 64, 64 * 1024 * 1024),
    disk_mb: int('disk_mb', 0, 1024 * 1024 * 1024),
    gpu: L.gpu === true,
    network: L.network === true,
    time_limit_minutes: int('time_limit_minutes', 1, 10080),
  }
  const inputs = m.inputs ?? []
  if (!Array.isArray(inputs) || inputs.length > 256) fail('inputs must be an array of at most 256 files')
  const names = new Set()
  for (const f of inputs) {
    if (!f || typeof f !== 'object' || !FILE_NAME.test(String(f.name ?? '')) || f.name === '.' || f.name === '..') fail(`inputs: bad file name ${JSON.stringify(f?.name)}`)
    if (names.has(f.name)) fail(`inputs: duplicate name ${f.name}`)
    names.add(f.name)
    let u; try { u = new URL(f.url) } catch { fail(`inputs: ${f.name} has no url`) }
    if (u.protocol !== 'https:') fail(`inputs: ${f.name} url must be https`)
    if (!Number.isInteger(Number(f.size_bytes)) || Number(f.size_bytes) < 0) fail(`inputs: ${f.name} size_bytes required`)
    // 10-25 — `sha256?` is OPTIONAL in the protocol and the hub sends `null` when it has no digest (job inputs
    // are uploads the hub never hashed). `!== undefined` let null through to String(null) = "null", every manifest
    // with an input was refused as «sha256 malformed», and the release blacklisted the piece for this node.
    if (f.sha256 != null && !/^[0-9a-f]{64}$/.test(String(f.sha256))) fail(`inputs: ${f.name} sha256 malformed`)
  }
  if (m.kind === 'python' && !inputs.some((f) => m.command.includes(`/job/in/${f.name}`))) fail('python: command must name a script from inputs as /job/in/<name>')
  const args = m.args ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('args must be an object')
  if (JSON.stringify(args).length > 64 * 1024) fail('args larger than 64 KB')
  const price = Number(m.price_per_minute_usd ?? 0)
  if (!(price >= 0)) fail('price_per_minute_usd malformed')
  return { attempt_id: m.attempt_id, piece_id: m.piece_id, job_id: m.job_id, kind: m.kind, image: m.image, command: [...m.command], env: Object.fromEntries(envEntries), args, limits, inputs: inputs.map((f) => ({ name: f.name, url: f.url, size_bytes: Number(f.size_bytes), sha256: f.sha256 ?? null })), price_per_minute_usd: price }
}

/**
 * The manifest against the owner's share: a job that asks for more than is shared is refused BEFORE
 * lease is confirmed (the hub should not offer it; the node checks anyway). Returns a reason or null.
 */
export function fitsShare(manifest, { share, found }) {
  const L = manifest.limits
  const cpu = share.cpu_cores ?? found?.cpu_cores ?? null
  const ram = share.ram_mb ?? found?.ram_mb ?? null
  const disk = share.disk_mb ?? found?.disk_free_mb ?? null
  if (cpu !== null && L.cpu_cores > cpu) return `needs ${L.cpu_cores} cores, ${cpu} shared`
  if (ram !== null && L.ram_mb > ram) return `needs ${L.ram_mb} MB RAM, ${ram} shared`
  if (disk !== null && L.disk_mb > disk) return `needs ${L.disk_mb} MB disk, ${disk} shared`
  if (L.gpu && !share.gpu) return 'needs a GPU, none shared'
  if (L.network && !share.allow_network) return 'needs network, not allowed'
  if (share.max_job_minutes && L.time_limit_minutes > share.max_job_minutes) return `time limit ${L.time_limit_minutes} min above the owner's ${share.max_job_minutes}`
  return null
}

/**
 * The runtime argv for one attempt. Fixed posture, never from the manifest:
 *   fresh container, named and labelled · --user uid:gid · --read-only rootfs · tmpfs /tmp · all caps dropped ·
 *   no-new-privileges · --cpus/--memory/--memory-swap (= memory, no swap)/--pids-limit · the job dir as the ONLY
 *   mount (/job) · --network none unless the job asked AND the owner allowed, then the per-job proxy network ·
 *   GPU only when asked and shared · env = the manifest's env + VERSUM_* facts, nothing from this process.
 */
export function containerArgs({ manifest, jobDir, name, uid, gid, runtime, network = null, gpu = false, tmpMb = 256 }) {
  const L = manifest.limits
  const args = ['run', '--name', name, '--label', 'versum.job=1', '--rm=false',
    '--user', `${uid}:${gid}`,
    '--read-only', '--tmpfs', `/tmp:rw,noexec,nosuid,size=${tmpMb}m`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--cpus', String(L.cpu_cores), '--memory', `${L.ram_mb}m`, '--memory-swap', `${L.ram_mb}m`, '--pids-limit', '512',
    '--workdir', '/job',
    '-v', `${jobDir}:/job${runtime === 'podman' ? ':Z' : ''}`]
  if (network?.name) args.push('--network', network.name, '-e', `HTTPS_PROXY=http://${network.proxy}:8888`, '-e', `HTTP_PROXY=http://${network.proxy}:8888`, '-e', 'NO_PROXY=localhost,127.0.0.1')
  else args.push('--network', 'none')
  if (gpu && L.gpu) args.push(...(runtime === 'podman' ? ['--device', 'nvidia.com/gpu=all'] : ['--gpus', 'all']))
  for (const [k, v] of Object.entries(manifest.env)) args.push('-e', `${k}=${v}`)
  args.push('-e', `VERSUM_JOB_ID=${manifest.job_id}`, '-e', `VERSUM_PIECE_ID=${manifest.piece_id}`, '-e', 'VERSUM_JOB_DIR=/job', '-e', 'HOME=/tmp')
  args.push(manifest.image, ...manifest.command)
  return args
}
