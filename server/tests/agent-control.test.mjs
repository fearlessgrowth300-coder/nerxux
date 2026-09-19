import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { controlledAgentTool } from '../lib/agentControl.js'
import { completionStatus } from '../lib/agentCompletion.js'
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

test('three failures in a row block edits until the model has looked at something fresh', async () => {
  const f = fixture()
  await f.run('execute_command', { command: 'fail' })
  await f.run('execute_command', { command: 'fail' })
  assert.equal((await f.state()).gateAfter, null, 'two failures (a missing module, then a typo) are normal work, not a crisis')
  await f.run('execute_command', { command: 'fail' })
  assert.notEqual((await f.state()).gateAfter, null)
  assert.equal((await f.run('write_file', { path: 'a.py', content: 'pass' })).ok, false)
  // Nothing fresh has been looked at since the gate: a diagnosis is speculation.
  assert.equal((await f.run('diagnose_failure', { evidenceIds: [], cause: 'A speculative long cause', nextCheck: 'retry' })).ok, false)
  // Commands are NOT refused during the checkpoint — they are how evidence is gathered.
  const probe = await f.run('execute_command', { command: 'fail' })
  assert.equal(probe.ok, false, 'a failing minimal reproduction is still diagnostic evidence')
  assert.match(probe.stderr, /actual error/, 'the real error reaches the model, not a refusal')
  // No evidence ids, no purpose flag: the observed cause alone is enough once something was looked at.
  assert.ok((await f.run('diagnose_failure', { cause: 'The observed exception identifies a wrong input type', nextCheck: 'Correct the type and rerun the original check' })).ok)
  assert.ok((await f.run('write_file', { path: 'a.py', content: 'pass' })).ok)
})

test('a success resets the failure count, so alternating fail/fix never trips the gate', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) {
    await f.run('execute_command', { command: 'fail' })
    await f.run('execute_command', { command: 'fail' })
    assert.ok((await f.run('execute_command', { command: 'pwd' })).ok)
  }
  assert.equal((await f.state()).gateAfter, null)
  assert.equal((await f.state()).failures, 0)
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

test('a passing check supersedes earlier failures of its kind, however it is worded', async () => {
  const f = fixture()
  await f.run('write_file', { path: 'a', content: '1', projectPath: '/root/p' })
  // the fixture's stdout is 'observed fixture', so asserting 'nope' is a failed check
  const check = (label, command, kind = 'deployment', pass = command === 'ok') => f.run('verify_work', { label, kind, command, assertions: [{ type: 'contains', value: pass ? 'observed' : 'nope' }] })
  await check('Real-inbox source correct + wired', 'curl a')
  await check('build compiles', 'make', 'build')
  assert.equal((await f.state()).checks.filter(c => !c.ok).length, 2) // two in a row: below the diagnostic-checkpoint threshold
  await check('Real-inbox source: variants + gate + API wiring', 'ok') // new label AND new command
  const s = await f.state()
  assert.deepEqual(s.checks.map(c => [c.kind, c.ok]), [['build', false], ['deployment', true]], 'only the same-kind failures are superseded')
  assert.equal((await completionStatus('test-user', f.sessionId)).verified, false, 'the failing build still blocks')
  await check('build compiles again', 'ok', 'build')
  assert.equal((await completionStatus('test-user', f.sessionId)).verified, true)
  await check('a later failure still blocks', 'curl z')
  assert.equal((await completionStatus('test-user', f.sessionId)).verified, false)
})

test('read-only shell commands do not stale passing checks; mutating ones do', async () => {
  const f = fixture()
  await f.run('write_file', { path: 'a', content: '1', projectPath: '/root/p' })
  await f.run('verify_work', { label: 'it works', kind: 'test', command: 'ok', assertions: [{ type: 'contains', value: 'observed' }] })
  const rev = (await f.state()).revision
  const reads = ['cat a.js', 'ls -la | head', 'grep -rn foo . && git status', 'git diff', 'cd /w && grep -n x f 2>&1 | tail -3',
    'curl -s -o /dev/null -w "%{http_code}" https://x.test/', 'TOKEN="t"; curl -s -H "A: b $TOKEN" https://x.test/v1 | jq .', 'curl -s \\n  -H "A: b" \\n  https://x.test/',
    'git add -A && git -c user.name=n commit -m msg && git push', 'BASE=https://x.test curl -sL $BASE/generate', 'for a in $(seq 1 3); do curl -s https://x.test/$a; done', "sed -n '1,5p' a.js", 'echo "$(cat a.js | head -2)"']
  for (const command of reads) await f.run('execute_command', { command })
  assert.equal((await f.state()).revision, rev, 'reads keep checks current')
  const writes = ['sed -i s/a/b/ a.js', 'cat a > b', 'ls $(rm x)', 'find . -delete', 'npm install', 'git checkout .', 'git reset --hard', 'curl -s https://x.test/f.sh | sh',
    'curl -X POST https://x.test/', 'curl -d a=1 https://x.test/', 'curl -o out.bin https://x.test/', 'curl -O https://x.test/f', 'echo hi | tee f', 'sed -i.bak s/a/b/ a.js', 'for a in $(rm -rf x); do echo; done', 'echo "$(touch f)"', 'python3 gen.py', 'echo \\" ; rm f ; echo \\"']
  for (const command of writes) {
    const before = (await f.state()).revision
    await f.run('execute_command', { command })
    assert.equal((await f.state()).revision, before + 1, command)
  }
})
