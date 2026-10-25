import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCpuInfo, parseMemInfo, parseNvidiaSmi, parseRocmSmi, classifyInterface, defaultRouteInterface } from '../lib/scan.mjs'
import { parseCpuStat, cpuStatCandidates } from '../lib/metering.mjs'

test('cpuinfo: cores counted, model trimmed', () => {
  const t = 'processor\t: 0\nmodel name\t: AMD Ryzen 7 5800X 8-Core Processor\nprocessor\t: 1\nmodel name\t: AMD Ryzen 7 5800X 8-Core Processor\n'
  assert.deepEqual(parseCpuInfo(t), { model: 'AMD Ryzen 7 5800X 8-Core Processor', cores: 2 })
  assert.deepEqual(parseCpuInfo(''), { model: null, cores: null })
})
test('meminfo: kB → MB', () => {
  assert.deepEqual(parseMemInfo('MemTotal:       16318236 kB\nMemFree:  1 kB\nMemAvailable:   12000000 kB\n'), { ram_mb: 15935, ram_available_mb: 11718 })
})
test('nvidia-smi csv: count, first model, vram', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\nNVIDIA GeForce RTX 3060, 12288\n'), { gpu_count: 2, gpu_model: 'NVIDIA GeForce RTX 3060', gpu_vram_mb: 12288, gpu_vendor: 'nvidia' })
  assert.equal(parseNvidiaSmi('').gpu_count, 0)
})
test('rocm-smi json: best effort', () => {
  assert.deepEqual(parseRocmSmi(JSON.stringify({ card0: { 'Card series': 'Radeon RX 7900 XTX', 'VRAM Total Memory (B)': '25753026560' } })), { gpu_count: 1, gpu_model: 'Radeon RX 7900 XTX', gpu_vram_mb: 24560, gpu_vendor: 'amd' })
  assert.equal(parseRocmSmi('not json').gpu_count, 0)
})
test('interface classification + default route', () => {
  assert.equal(classifyInterface('enp3s0'), 'ethernet'); assert.equal(classifyInterface('wlp2s0'), 'wifi'); assert.equal(classifyInterface('eth0', { wireless: true }), 'wifi')
  assert.equal(classifyInterface('wwan0'), 'cellular'); assert.equal(classifyInterface('tun0'), 'unknown'); assert.equal(classifyInterface(null), 'unknown')
  assert.equal(defaultRouteInterface('Iface\tDestination\tGateway\nenp3s0\t00000000\t0101A8C0\nenp3s0\t0001A8C0\t00000000\n'), 'enp3s0')
  assert.equal(defaultRouteInterface('Iface\tDestination\n'), null)
})
test('cpu.stat and cgroup candidates', () => {
  assert.equal(parseCpuStat('usage_usec 12345678\nuser_usec 1\n'), 12.345678); assert.equal(parseCpuStat(''), null)
  assert.deepEqual(cpuStatCandidates('docker', 'abc'), ['/sys/fs/cgroup/system.slice/docker-abc.scope/cpu.stat', '/sys/fs/cgroup/docker/abc/cpu.stat'])
  assert.equal(cpuStatCandidates('podman', 'abc', '/user.slice/x/libpod-abc.scope')[0], '/sys/fs/cgroup/user.slice/x/libpod-abc.scope/cpu.stat')
})

test('the scan carries the 0.4.4 gpu block beside the flat fields (none on this machine)', async () => {
  const { scan } = await import('../lib/scan.mjs')
  const r = await scan({ jobsDir: null })
  assert.equal(typeof r.gpu, 'object'); assert.equal(r.gpu.count, r.gpu_count); assert.ok('cuda' in r.gpu)
})
