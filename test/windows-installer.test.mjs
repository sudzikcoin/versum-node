// The Windows installer's scripts, statically. v0.3.0 shipped BOM-less UTF-8 .ps1 files with arrows and check
// marks: Windows PowerShell 5.1 read them as cp1252, the bytes became curly quotes, the parser failed, and the
// window closed before a single line -- a silent failure on every real machine. These checks keep that out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p))

test('install.ps1 and setup.ps1 are pure ASCII (5.1 has no BOM to tell it UTF-8)', () => {
  for (const f of ['install.ps1', 'packaging/windows/setup.ps1']) {
    const b = read(f)
    const bad = [...b].map((c, i) => [c, i]).filter(([c]) => c > 0x7e || (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09))
    assert.deepEqual(bad.slice(0, 3), [], `${f}: non-ASCII byte(s) at offset ${bad.map(([, i]) => i).slice(0, 3)}`)
  }
})

test('setup.cmd is ASCII with CRLF line endings (cmd.exe misreads LF-only files)', () => {
  const s = read('packaging/windows/setup.cmd').toString('latin1')
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), 'non-ASCII in setup.cmd')
  assert.ok(!/[^\r]\n/.test(s) && !s.startsWith('\n'), 'LF without CR in setup.cmd')
  assert.match(s, /-ExecutionPolicy Bypass -File "%~dp0setup\.ps1" %\*/, 'runs setup.ps1 with Bypass and passes the arguments through')
  assert.match(s, /install\.log/, 'names the log')
  assert.match(s, /pause/, 'waits on failure')
})

test('the Inno script ships setup.cmd and runs it (not powershell.exe directly)', () => {
  const iss = read('packaging/windows/versum-node.iss').toString()
  assert.match(iss, /Source: "\{#SourceDir\}\\packaging\\windows\\setup\.cmd"; DestDir: "\{app\}"/)
  assert.match(iss, /Source: "\{#SourceDir\}\\packaging\\windows\\setup\.ps1"; DestDir: "\{app\}"/)
  assert.match(iss, /\[Run\][\s\S]*Filename: "\{app\}\\setup\.cmd"; Parameters: "-Source ""\{srcexe\}"""/)
  assert.match(iss, /Versum node setup \(run again\)"; Filename: "\{app\}\\setup\.cmd"/)
  assert.match(iss, /install\.log/, 'a Start-menu entry opens the log')
  for (const f of ['packaging/windows/setup.cmd', 'packaging/windows/setup.ps1', 'install.ps1']) assert.ok(existsSync(join(root, f)), f)
})

test('setup.ps1 reads key and hub from the file name, tolerates a browser "(1)" suffix, and has a -DryRun', () => {
  const s = read('packaging/windows/setup.ps1').toString()
  assert.match(s, /param\(\[string\]\$Source = '', \[switch\]\$Uninstall, \[switch\]\$DryRun\)/)
  assert.match(s, /'llk_\[0-9A-Za-z\]\{32\}'/)
  assert.match(s, /'-hub-\(\[A-Za-z0-9\._~-\]\+\)'/, 'hub regex must not be anchored to .exe$')
  assert.match(s, /VERSUM_NODE_DRYRUN = '1'/)
  assert.match(s, /exit 3/, 'stopped-and-shown exit code for setup.cmd')
  const i = read('install.ps1').toString()
  assert.match(i, /\$DryRun = \(\$env:VERSUM_NODE_DRYRUN -eq '1'\)/)
  assert.match(i, /Get-Command \$exe -ErrorAction SilentlyContinue/, 'never assumes wsl.exe exists')
  assert.match(i, /function Stop-Here/)
  assert.match(i, /install\.log/)
})
