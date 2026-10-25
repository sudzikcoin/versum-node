import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { platformKey, planFor, stampOf, describePylib } from '../lib/pylib.mjs'
import { nativeEnv, nativeCommand, sandboxProfile } from '../lib/native.mjs'

const lock = JSON.parse(readFileSync(new URL('../pylib-lock.json', import.meta.url), 'utf8'))
const manifest = { kind: 'python', job_id: 'j', piece_id: 'p', attempt_id: 'a', env: {}, limits: { cpu_cores: 2, ram_mb: 1024, time_limit_minutes: 5 }, command: ['python', '/job/in/main.py'] }

test('the lock ships every package of the standard image for the three native platforms, pinned and hashed', () => {
  for (const key of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
    const { wheels } = planFor(lock, ...key.split('-').map((x, i) => (i === 0 ? x : x)))
    const names = new Set(wheels.map((w) => w.name.toLowerCase().replace(/-/g, '_')))
    for (const p of ['numpy', 'pandas', 'pillow', 'requests', 'pypdf', 'openpyxl', 'python_docx']) assert.ok(names.has(p), `${key} has ${p}`)
    assert.ok(wheels.find((w) => w.name === 'numpy').version === '2.1.3' && wheels.find((w) => w.name === 'pandas').version === '2.2.3', 'the image versions')
    for (const w of wheels) assert.match(w.sha256, /^[0-9a-f]{64}$/)
  }
  assert.equal(platformKey('linux', 'x64'), null, 'Linux runs the image, no wheels')
  assert.deepEqual(planFor(lock, 'linux', 'x64'), { key: null, wheels: [] })
  assert.throws(() => planFor({ platforms: { 'win32-x64': [{ file: 'x.whl', url: 'http://evil', sha256: 'zz' }] } }, 'win32', 'x64'), /malformed/)
  assert.throws(() => planFor({ platforms: {} }, 'win32', 'x64'), /no wheels/)
})

test('the stamp follows the lock: any sha change re-installs', () => {
  const a = stampOf(lock, planFor(lock, 'win32', 'x64'))
  const changed = JSON.parse(JSON.stringify(lock)); changed.platforms['win32-x64'][0].sha256 = '0'.repeat(64)
  assert.notEqual(a, stampOf(changed, planFor(changed, 'win32', 'x64')))
  assert.equal(describePylib({ status: 'pending', done: 3, total: 18, bytes_total: 62 * 1048576 }), 'preparing Python packages, 62 MB (3 of 18)')
  assert.equal(describePylib({ status: 'ok', total: 18 }), 'Python packages ready (18 wheels)')
})

test('the interpreter sees the packages: PYTHONPATH set, -E gone, the Seatbelt profile reads the folder', () => {
  const env = nativeEnv(manifest, { jobDir: 'C:\\jobs\\a', pythonDir: 'C:\\py', pylibDir: 'C:\\state\\pylib', platform: 'win32' })
  assert.equal(env.PYTHONPATH, 'C:\\state\\pylib'); assert.equal(env.PYTHONNOUSERSITE, '1')
  assert.equal(nativeEnv(manifest, { jobDir: '/j', pythonDir: '/py', platform: 'darwin' }).PYTHONPATH, undefined, 'no packages yet: no PYTHONPATH')
  const argv = nativeCommand(manifest, { jobDir: '/j', python: '/py/bin/python3', platform: 'darwin' })
  assert.ok(!argv.includes('-E') && argv.includes('-s'), 'PYTHONPATH must reach the interpreter; user site stays off')
  assert.match(sandboxProfile({ jobDir: '/j', pythonDir: '/py', pylibDir: '/state/pylib' }), /\(allow file-read\* \(subpath "\/state\/pylib"\)\)/)
})
