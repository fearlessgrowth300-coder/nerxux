import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { projectNotes } from '../lib/agentState.js'
import { restartService, restartableServices } from '../lib/agentLoop.js'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-notes-'))
after(() => fs.rm(dir, { recursive: true, force: true }))

test('NEXUS.md at the project root reaches the model, redacted and bounded; absent file adds nothing', async () => {
  assert.equal(await projectNotes(dir), '')
  await fs.writeFile(path.join(dir, 'NEXUS.md'), '# viewe\nRun tests with venv/bin/python.\nDASHBOARD_SECRET=supersecretvalue123\n' + 'x'.repeat(20000))
  const notes = await projectNotes(dir)
  assert.match(notes, /Project notes \(NEXUS\.md/)
  assert.match(notes, /venv\/bin\/python/)
  assert.doesNotMatch(notes, /supersecretvalue123/)
  assert.match(notes, /truncated/)
  assert.ok(notes.length < 9600)
  assert.equal(await projectNotes(null), '')
})

test('restart_service only touches allow-listed services and never the Nexus server', async () => {
  assert.deepEqual(restartableServices({ NEXUS_RESTARTABLE_SERVICES: 'viewe-dashboard, nexus-server, other-app' }), ['viewe-dashboard', 'other-app'])
  const calls = []
  const exec = async (cmd, argv) => { calls.push([cmd, ...argv]); return { code: 0, stdout: argv[0] === 'jlist' ? JSON.stringify([{ name: 'viewe-dashboard', pid: 42, pm2_env: { status: 'online', restart_time: 3 } }]) : '[PM2] restarted', stderr: '' } }
  const refused = await restartService('nexus-server', { exec, env: {} })
  assert.equal(refused.ok, false)
  assert.equal(calls.length, 0, 'a refused name must not run anything')
  const ok = await restartService('viewe-dashboard', { exec, env: {} })
  assert.equal(ok.ok, true)
  assert.deepEqual(calls[0], ['pm2', 'restart', 'viewe-dashboard', '--update-env'])
  assert.match(ok.stdout, /online, restarts=3/)
})
