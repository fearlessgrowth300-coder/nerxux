import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { controlledAgentTool } from '../lib/agentControl.js'
import { readAgentState, withAgentState, verificationFooter, evaluateAssertions } from '../lib/agentState.js'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-test-'))
process.env.NEXUS_AGENT_STATE_DIR = dir
after(() => fs.rm(dir, { recursive: true, force: true }))
const success = { ok: true, exitCode: 0, stdout: 'observed fixture', stderr: '', durationMs: 1 }
function fixture() {
  const sessionId = randomUUID(), userId = 'test-user', calls = []
  const execute = async i => { calls.push(i); return i.args.command === 'fail' ? { ...success, ok: false, exitCode: 1, stderr: 'actual error' } : { ...success, stdout: i.args.command === 'zero' ? '{"items":0}' : i.args.command === 'positive' ? '{"items":2}' : success.stdout } }
  return { sessionId, userId, calls, run: (name, args = {}) => controlledAgentTool({ name, args, sessionId, userId }, execute), state: () => readAgentState(userId, sessionId) }
}

test('project lock persists on disk and cannot silently switch to the pod or another project', async () => {
  const f = fixture()
  assert.ok((await f.run('list_files', { projectPath: '/root/project' })).ok)
  assert.equal((await f.state()).projectPath, '/root/project')
  const before = f.calls.length
  assert.equal((await f.run('execute_command', { command: 'pwd', target: 'pod' })).ok, false)
  assert.equal((await f.run('write_file', { path: 'a', content: '', projectPath: '/tmp/elsewhere' })).ok, false)
  assert.equal((await f.run('list_files', { projectPath: '' })).ok, false)
  assert.equal(f.calls.length, before, 'refused actions never reach execution')
  assert.ok((await f.run('set_execution_context', { environment: 'pod', projectPath: '/tmp', reason: 'explicit GPU fixture' })).ok)
  assert.ok((await f.run('execute_command', { command: 'pwd' })).ok)
  assert.equal(f.calls.at(-1).executionEnvironment, 'pod')
  assert.equal((await readAgentState('another-user', f.sessionId)).projectPath, null)
})

test('two failures block edits until fresh diagnostic evidence is supplied, across reads of disk state', async () => {
  const f = fixture()
  await f.run('execute_command', { command: 'fail' })
  await f.run('execute_command', { command: 'fail' })
  assert.notEqual((await f.state()).gateAfter, null)
  assert.equal((await f.run('write_file', { path: 'a.py', content: 'pass' })).ok, false)
  assert.equal((await f.run('diagnose_failure', { evidenceIds: [], cause: 'A speculative long cause', nextCheck: 'retry' })).ok, false)
  const read = await f.run('read_file', { path: 'a.py' })
  const probe = await f.run('execute_command', { command: 'fail', purpose: 'diagnostic' })
  assert.equal(probe.ok, false, 'a failing minimal reproduction is still diagnostic evidence')
  assert.ok((await f.run('diagnose_failure', { evidenceIds: [read.evidenceId, probe.evidenceId], cause: 'The observed exception identifies a wrong input type', nextCheck: 'Correct the type and rerun the original check' })).ok)
  assert.ok((await f.run('write_file', { path: 'a.py', content: 'pass' })).ok)
})

test('an explicit context switch wins over the original request project and a used workspace cannot silently remount', async () => {
  const userId = 'test-user', sessionId = randomUUID()
  const calls = []
  const run = (name, args = {}) => controlledAgentTool({ userId, sessionId, projectPath: '/root/initial', name, args }, async i => { calls.push(i); return success })
  await run('read_file', { path: 'a.py' })
  await run('set_execution_context', { environment: 'pod', projectPath: '/tmp', reason: 'explicit test' })
  assert.ok((await run('execute_command', { command: 'pwd' })).ok)
  assert.equal(calls.at(-1).projectPath, '/tmp')
  await run('set_execution_context', { environment: 'sandbox', projectPath: '', reason: 'return to conversation files' })
  assert.ok((await run('list_files')).ok)
  assert.equal(calls.at(-1).projectPath, null)
  const f = fixture()
  await f.run('write_file', { path: 'a.py', content: 'pass' })
  assert.equal((await f.run('read_file', { path: 'a.py', projectPath: '/root/other' })).ok, false)
})

test('verification rejects zero work even when the command exits zero, and edits stale passing checks', async () => {
  const f = fixture()
  const verify = { label: 'At least one item processed', kind: 'test', assertions: [{ type: 'json_number', field: 'items', min: 1 }] }
  assert.equal((await f.run('verify_work', { ...verify, command: 'zero' })).ok, false)
  assert.ok((await f.run('verify_work', { ...verify, command: 'positive' })).ok)
  assert.match(await verificationFooter(f.userId, f.sessionId), /At least one item processed/)
  await f.run('write_file', { path: 'a.py', content: 'pass' })
  assert.match(await verificationFooter(f.userId, f.sessionId), /none recorded for the current files/)
  assert.match(await verificationFooter(f.userId, f.sessionId), /Deployment is unverified/)
  assert.throws(() => evaluateAssertions('PASS', []), /assertions/)
  assert.throws(() => evaluateAssertions('{"items":"2"}', verify.assertions), /must be a number/)
})

test('crash marker survives inspections and prevents unverified continuation', async () => {
  const f = fixture()
  await withAgentState(f.userId, f.sessionId, async s => { s.inFlight = { tool: 'execute_command', startedAt: 'test' } })
  await f.run('inspect_execution')
  await f.run('read_file', { path: 'a.py' })
  assert.ok((await f.state()).inFlight)
  assert.equal((await f.run('write_file', { path: 'a.py', content: 'pass' })).ok, false)
})

test('concurrent calls serialize and notes redact recognized credentials', async () => {
  const f = fixture()
  await Promise.all(Array.from({ length: 6 }, () => f.run('list_files')))
  assert.equal((await f.state()).sequence, 6)
  const token = 'ghp_' + 'a'.repeat(36)
  await f.run('record_progress', { nextStep: 'Check again ' + token })
  assert.ok(!(await f.state()).nextStep.includes(token))
  assert.equal((await f.state()).checks.length, 0)
})
