/**
 * 0.4.8 — text to image against the owner's own image server: ComfyUI (8188) or A1111 (7860).
 *
 * The buyer sends words and numbers (prompt, negative, width, height, steps, seed); the node submits the job to
 * the local HTTP API, polls until it is done and hands the PNG bytes back to the relay, which posts them to the
 * hub as the job's output files. Nothing is written to this computer's disk by us: ComfyUI writes its own output
 * into its own folder as it always does (that is the owner's program behaving as it already does), and we read the
 * bytes over its /view endpoint; the A1111 path never touches the disk at all (base64 in the answer).
 *
 * The ComfyUI workflow is OURS and ships here (WORKFLOW): a plain txt2img graph — checkpoint → CLIP ×2 → empty
 * latent → KSampler → VAE decode → SaveImage. The checkpoint is the model the owner picked from what the service
 * itself reported (/object_info), never a name we invented.
 */

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_IMAGES = 4

/** Pure: the buyer's arguments → the numbers both servers take. Multiples of 8 for the size; a seed we can repeat. */
export function imageParams(req = {}) {
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d }
  const eight = (v, d) => { const x = n(v, 64, 2048, d); return x - (x % 8) }
  const prompt = String(req.prompt ?? '').trim()
  if (!prompt) throw new Error('an image needs a prompt')
  return {
    prompt: prompt.slice(0, 2000),
    negative: String(req.negative ?? req.negative_prompt ?? '').slice(0, 2000),
    width: eight(req.width, 512), height: eight(req.height, 512),
    steps: n(req.steps, 1, 100, 20), cfg: Number.isFinite(Number(req.cfg)) ? Math.min(30, Math.max(1, Number(req.cfg))) : 7,
    seed: Number.isFinite(Number(req.seed)) && Number(req.seed) >= 0 ? Math.floor(Number(req.seed)) : Math.floor(Math.random() * 2 ** 32),
    count: n(req.count ?? req.n, 1, MAX_IMAGES, 1),
  }
}

/** Pure: our default txt2img graph for ComfyUI, with the owner's checkpoint and the buyer's numbers. */
export function WORKFLOW(ckpt, p) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: p.count } },
    '5': { class_type: 'KSampler', inputs: { seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'versum', images: ['6', 0] } },
  }
}

/** Pure: a ComfyUI /object_info body → the checkpoints it reports (what the owner may pick from). */
export function comfyCheckpoints(objectInfo) {
  const opts = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name
  const list = Array.isArray(opts) ? opts[0] : null
  return (Array.isArray(list) ? list : []).map(String).filter(Boolean).slice(0, 40)
}

/** Pure: a history entry → the images it wrote, as { filename, subfolder, type }. */
export function comfyImages(entry) {
  const out = []
  for (const node of Object.values(entry?.outputs ?? {})) for (const im of Array.isArray(node?.images) ? node.images : []) if (im?.filename) out.push({ filename: String(im.filename), subfolder: String(im.subfolder ?? ''), type: String(im.type ?? 'output') })
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** ComfyUI: POST /prompt, poll /history/<id>, read each PNG from /view. Returns [{ name, content_type, bytes }]. */
export async function generateComfy(svc, req, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onNote = () => {}) {
  const p = imageParams(req)
  const ckpt = String(req.model ?? svc.details?.checkpoint ?? svc.model ?? '')
  if (!ckpt || ckpt === 'comfyui') throw new Error('this ComfyUI has no checkpoint picked by its owner')
  const client_id = `versum-${Math.random().toString(36).slice(2, 10)}`
  const r = await fetchImpl(`${svc.base_url}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: WORKFLOW(ckpt, p), client_id }) })
  if (!r.ok) throw new Error(`comfyui answered ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const { prompt_id } = await r.json()
  if (!prompt_id) throw new Error('comfyui gave no prompt_id')
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000)
    const h = await fetchImpl(`${svc.base_url}/history/${prompt_id}`).catch(() => null)
    const body = h && h.ok ? await h.json().catch(() => null) : null
    const entry = body?.[prompt_id]
    if (entry) {
      const status = entry.status?.status_str ?? 'done'
      if (status === 'error') throw new Error(`comfyui failed: ${JSON.stringify(entry.status?.messages ?? []).slice(0, 300)}`)
      const images = comfyImages(entry)
      if (images.length) {
        const files = []
        for (const [i, im] of images.slice(0, MAX_IMAGES).entries()) {
          const v = await fetchImpl(`${svc.base_url}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder)}&type=${encodeURIComponent(im.type)}`)
          if (!v.ok) throw new Error(`comfyui /view answered ${v.status}`)
          files.push({ name: `image-${i + 1}.png`, content_type: 'image/png', bytes: Buffer.from(await v.arrayBuffer()) })
        }
        return { files, seed: p.seed, model: ckpt }
      }
    }
    const q = await fetchImpl(`${svc.base_url}/queue`).catch(() => null)
    const qb = q && q.ok ? await q.json().catch(() => null) : null
    const note = `${(qb?.queue_running ?? []).length} running, ${(qb?.queue_pending ?? []).length} queued`
    if (note !== last) { last = note; onNote(note) }
  }
  throw new Error(`comfyui did not finish within ${Math.round(timeoutMs / 1000)} s`)
}

/** A1111: POST /sdapi/v1/txt2img — one call, base64 PNGs in the answer. */
export async function generateA1111(svc, req, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const p = imageParams(req)
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const body = { prompt: p.prompt, negative_prompt: p.negative, width: p.width, height: p.height, steps: p.steps, cfg_scale: p.cfg, seed: p.seed, batch_size: p.count, ...(svc.model && svc.model !== 'a1111' ? { override_settings: { sd_model_checkpoint: svc.model }, override_settings_restore_afterwards: true } : {}) }
    const r = await fetchImpl(`${svc.base_url}/sdapi/v1/txt2img`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(`a1111 answered ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const j = await r.json()
    const imgs = (Array.isArray(j.images) ? j.images : []).slice(0, MAX_IMAGES)
    if (!imgs.length) throw new Error('a1111 returned no image')
    return { files: imgs.map((b64, i) => ({ name: `image-${i + 1}.png`, content_type: 'image/png', bytes: Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64') })), seed: p.seed, model: svc.model }
  } finally { clearTimeout(t) }
}

/** The relay's entry point for kind=image. */
export async function generateImage(svc, req, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onNote = () => {}) {
  if (svc.provider === 'comfyui') return generateComfy(svc, req, fetchImpl, timeoutMs, onNote)
  if (svc.provider === 'a1111') return generateA1111(svc, req, fetchImpl, timeoutMs)
  throw new Error(`${svc.provider} is not an image server this node can drive`)
}
