import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { redactSecrets, redactToolData } from '../lib/redact.js'
import { sandboxEnvironment } from '../lib/sandbox.js'
import { fitMessages, estimateTokens } from '../lib/fitContext.js'
import { withAgentState } from '../lib/agentState.js'
import { createCompletionCheck, finishAgentResponse } from '../lib/agentCompletion.js'
import { controlledAgentTool } from '../lib/agentControl.js'
import { runWebSearchTool } from '../lib/webSearch.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-reliability-'))
process.env.NEXUS_AGENT_STATE_DIR = root
after(() => fs.rm(root, { recursive: true, force: true }))

test('proxy passwords and infrastructure keys are removed from observations without exposing env to children', () => {
  const secret = 'fixture-credential-123456789'
  const result = redactToolData({ args: { password: secret }, stdout: `{"password":"${secret}"}\nRUNPOD_API_KEY=rpa_abcdefghijklmnopqrstuv\nPATH=/usr/bin` })
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('abcdefghijklmnopqrstuv'))
  assert.match(result.stdout, /PATH=\/usr\/bin/)
  assert.equal(redactSecrets('http://account:secret@proxy.example'), 'http://***@proxy.example')
  assert.deepEqual(sandboxEnvironment({ PATH: '/usr/bin', HOME: '/root', SUPABASE_SERVICE_ROLE_KEY: secret, RUNPOD_API_KEY: secret }), { PATH: '/usr/bin', HOME: '/root' })
})

test('context includes native tool argument cost and cannot begin with an orphan tool reply', () => {
  const call = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { content: 'x'.repeat(15000) } } }] }
  assert.ok(estimateTokens(call) > 4000)
  const fit = fitMessages([{ role: 'system', content: 'rules' }, call, { role: 'tool', tool_name: 'write_file', content: 'wrote fixture' }], 150)
  assert.ok(!fit.messages.some(m => m.role === 'tool'))
  assert.match(fit.messages.at(-1).content, /Earlier tool observation/)
  assert.ok(fit.estimated <= 150)
})

test('completion recovery is bounded, failing or stale checks cannot certify work', async () => {
  const session = randomUUID()
  await withAgentState('test', session, async s => { s.revision = 2; s.changes.push({ path: 'fixture.py' }); s.checks.push({ revision: 1, ok: true, label: 'old test' }) })
  const check = createCompletionCheck('test', session)
  assert.match(await check(), /verify_work/)
  assert.match(await check(), /verify_work/)
  assert.equal(await check(), null)
  assert.equal((await finishAgentResponse('Done', 'test', session)).verificationStatus, 'unverified')
  await withAgentState('test', session, async s => { s.checks = [{ revision: 2, ok: true, label: 'real test' }] })
  assert.equal((await finishAgentResponse('Done', 'test', session)).verificationStatus, 'checks_passed')
  await withAgentState('test', session, async s => { s.jobs = [{ id: 'job_fixture', status: 'running' }] })
  assert.equal((await finishAgentResponse('Done', 'test', session)).verificationStatus, 'unverified')
})

test('unregistered jobs and background start receipts cannot pass verification', async () => {
  let executed = false
  const input = { userId: 'test', sessionId: randomUUID() }
  const execute = async () => { executed = true; return { ok: true, exitCode: 0, stdout: 'started' } }
  assert.equal((await controlledAgentTool({ ...input, name: 'job_status', args: { jobId: 'job_other' } }, execute)).ok, false)
  assert.equal((await controlledAgentTool({ ...input, name: 'verify_work', args: { command: 'server', background: true, label: 'bad proof', kind: 'test', assertions: [{ type: 'contains', value: 'started' }] } }, execute)).ok, false)
  assert.equal(executed, false)
})

test('web search reports configuration failure as failure', async () => {
  const old = process.env.BRAVE_SEARCH_API_KEY
  delete process.env.BRAVE_SEARCH_API_KEY
  try { assert.equal((await runWebSearchTool({ query: 'fixture' })).ok, false) }
  finally { if (old !== undefined) process.env.BRAVE_SEARCH_API_KEY = old }
})
