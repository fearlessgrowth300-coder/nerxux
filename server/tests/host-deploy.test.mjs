import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deployService, validateCwd, validateService } from '../lib/hostDeploy.js'
import { exposeSite, validateSite, caddySite, ensureDnsRecord } from '../lib/hostSite.js'

const env = { NEXUS_APP_ROOTS: os.tmpdir(), NEXUS_SITE_DOMAINS: 'legacynerxux.online', NEXUS_PUBLIC_IP: '2.25.126.125', HOSTINGER_API_TOKEN: 'fixture-token' }

test('deploy_service refuses the Nexus server, bad names, bad folders and multi-line commands without running anything', async () => {
  const calls = []
  const exec = async (cmd, argv) => { calls.push([cmd, ...argv]); return { code: 0, stdout: '[]', stderr: '' } }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-app-'))
  try {
    for (const bad of [
      { name: 'nexus-server', command: 'node x', cwd: dir },
      { name: 'x; rm -rf /', command: 'node x', cwd: dir },
      { name: 'ok', command: 'node x', cwd: '/etc' },
      { name: 'ok', command: 'node x', cwd: '/root/nerxux/server' },
      { name: 'ok', command: 'node x' + String.fromCharCode(10) + 'rm -rf /', cwd: dir },
      { name: 'ok', command: 'node x', cwd: dir, env: { 'bad key': 'v' } },
    ]) {
      const r = await deployService(bad, { exec, env: { ...env, NEXUS_APP_ROOTS: os.tmpdir() + ',/root' } })
      assert.equal(r.ok, false, JSON.stringify(bad))
    }
    assert.equal(calls.length, 0, 'refused deployments never reach pm2')
    assert.equal(validateService('viewe-dashboard'), null)
    assert.match(validateCwd('/root/nerxux', {}), /Nexus checkout/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('deploy_service starts the app as bash -c in its folder, saves, and reports the PM2 status', async () => {
  const calls = []
  const exec = async (cmd, argv) => {
    calls.push([cmd, ...argv])
    if (argv[0] === 'jlist') return { code: 0, stdout: JSON.stringify([{ name: 'hello', pid: 7, pm2_env: { status: 'online', restart_time: 0 } }]), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  // The host is Linux; the suite also runs on Windows, so the folder check is a fake posix stat.
  const fsImpl = { stat: async (p) => ({ isDirectory: () => p === '/srv/hello' }) }
  const r = await deployService({ name: 'hello', command: 'python3 -m http.server 8010', cwd: '/srv/hello', env: { PORT: '8010' } }, { exec, env: { ...env, NEXUS_APP_ROOTS: '/srv' }, fsImpl })
  assert.equal(r.ok, true, r.stderr)
  const start = calls.find((c) => c[1] === 'start')
  assert.deepEqual(start, ['pm2', 'start', 'bash', '--name', 'hello', '--cwd', '/srv/hello', '--', '-c', 'python3 -m http.server 8010'])
  assert.ok(calls.some((c) => c[1] === 'save'))
  assert.match(r.stdout, /online/)
})

test('expose_site validates host and port and refuses Nexus ports', () => {
  assert.match(validateSite('myapp.legacynerxux.online', 8010, env).label, /^myapp$/)
  assert.match(validateSite('evil.example.com', 8010, env).error, /subdomain of legacynerxux\.online/)
  assert.match(validateSite('a.b.legacynerxux.online', 8010, env).error, /one label/)
  assert.match(validateSite('myapp.legacynerxux.online', 4000, env).error, /belongs to Nexus/)
  assert.match(validateSite('myapp.legacynerxux.online', 80, env).error, /1024/)
  assert.match(caddySite('myapp.legacynerxux.online', 8010), /reverse_proxy 127\.0\.0\.1:8010/)
})

test('expose_site adds the DNS record only when missing, writes the Caddy site, validates and reloads', async () => {
  const dnsCalls = []
  const fetchImpl = async (url, init = {}) => {
    dnsCalls.push(init.method || 'GET')
    if (!init.method) return { ok: true, json: async () => [{ type: 'A', name: '@', records: [{ content: '2.57.91.91' }] }] }
    return { ok: true, text: async () => '', json: async () => ({ message: 'Request accepted' }) }
  }
  const files = {}
  const fsImpl = { mkdir: async () => {}, writeFile: async (f, c) => { files[f] = c }, rm: async (f) => { delete files[f] } }
  const execCalls = []
  const exec = async (cmd, argv) => { execCalls.push([cmd, ...argv]); return { code: 0, stdout: '', stderr: '' } }
  const r = await exposeSite({ host: 'MyApp.legacynerxux.online', port: 8010 }, { exec, fetchImpl, env, fsImpl })
  assert.equal(r.ok, true, r.stderr)
  assert.deepEqual(dnsCalls, ['GET', 'PUT'])
  assert.match(files['/etc/caddy/sites/myapp.legacynerxux.online.caddy'], /reverse_proxy 127\.0\.0\.1:8010/)
  assert.deepEqual(execCalls.map((c) => c.slice(0, 2)), [['caddy', 'validate'], ['systemctl', 'reload']])
  // second time: record exists -> no PUT
  const again = await ensureDnsRecord('legacynerxux.online', 'myapp', '2.25.126.125', { env, fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'A', name: 'myapp', records: [{ content: '2.25.126.125' }] }] }) })
  assert.deepEqual(again, { ok: true, existed: true })
})

test('a Caddy validation failure removes the site file and reports the error', async () => {
  const files = {}
  const fsImpl = { mkdir: async () => {}, writeFile: async (f, c) => { files[f] = c }, rm: async (f) => { delete files[f] } }
  const exec = async (cmd) => cmd === 'caddy' ? { code: 1, stdout: '', stderr: 'adapting config: bad' } : { code: 0, stdout: '', stderr: '' }
  const fetchImpl = async (url, init = {}) => init.method ? { ok: true, text: async () => '' } : { ok: true, json: async () => [] }
  const r = await exposeSite({ host: 'x.legacynerxux.online', port: 8011 }, { exec, fetchImpl, env, fsImpl })
  assert.equal(r.ok, false)
  assert.match(r.stderr, /Caddy rejected/)
  assert.equal(Object.keys(files).length, 0)
})
