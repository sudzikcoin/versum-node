#!/usr/bin/env node
/**
 * The single binary (Node.js single executable application, v0.4.0).
 *
 *   node scripts/build-sea.mjs bundle   bin/versum-node.mjs + lib → dist/sea/versum-node.cjs (esbuild, CommonJS: SEA runs CJS only)
 *   node scripts/build-sea.mjs blob     → dist/sea/sea-prep.blob (node --experimental-sea-config sea-config.json)
 *   node scripts/build-sea.mjs inject <node binary> <out binary>
 *                                        copies the binary and injects the blob with postject (macOS: removes
 *                                        the signature first and ad-hoc signs afterwards)
 *
 * import.meta.url has no meaning in CommonJS; the bundle gets it from __filename, and node.mjs resolves
 * APP_ROOT to the executable's directory when it runs as a SEA (process.getBuiltinModule('node:sea')).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist', 'sea')
const [cmd, ...rest] = process.argv.slice(2)
const run = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: 'inherit', cwd: root, ...opts })
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

if (cmd === 'bundle') {
  mkdirSync(dist, { recursive: true })
  run(npx, ['--yes', 'esbuild@0.24.2', 'bin/versum-node.mjs', '--bundle', '--platform=node', '--target=node20', '--format=cjs', `--outfile=${join(dist, 'versum-node.cjs')}`,
    '--define:import.meta.url=__versum_meta_url', '--banner:js=const __versum_meta_url = require("node:url").pathToFileURL(__filename).href;', '--log-level=warning'], { shell: process.platform === 'win32' })
  console.log(`bundle: ${join(dist, 'versum-node.cjs')} (${statSync(join(dist, 'versum-node.cjs')).size} bytes)`)
} else if (cmd === 'blob') {
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json'])
  console.log(`blob: ${join(dist, 'sea-prep.blob')} (${statSync(join(dist, 'sea-prep.blob')).size} bytes)`)
} else if (cmd === 'inject') {
  const [src, out] = rest
  if (!src || !out) throw new Error('usage: inject <node binary> <out binary>')
  const blob = join(dist, 'sea-prep.blob')
  if (!existsSync(blob)) throw new Error('run `blob` first')
  mkdirSync(dirname(out), { recursive: true })
  copyFileSync(src, out)
  if (process.platform !== 'win32') chmodSync(out, 0o755)
  if (process.platform === 'darwin') run('codesign', ['--remove-signature', out])
  const args = ['--yes', 'postject@1.0.0-alpha.6', out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA')
  run(npx, args, { shell: process.platform === 'win32' })
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', out])
  console.log(`binary: ${out} (${statSync(out).size} bytes)`)
} else {
  console.error('usage: build-sea.mjs bundle | blob | inject <node> <out>')
  process.exit(2)
}
