import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { run } from '../adapters/ollama.js'
import { executeInSandbox } from '../lib/sandbox.js'

// Explicit opt-in: needs the actual Linux bubblewrap runtime. No model or
// network calls; only tiny Python fixtures in a disposable project directory.
test('real sandbox failures, reads, patches and reruns reach the model faithfully', {
  skip: process.platform !== 'linux' || process.env.NEXUS_SANDBOX_TESTS !== '1',
}, async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-recovery-test-'))
  process.env.NEXUS_AGENT_STATE_DIR = path.join(projectPath, 'test-state')
  const sessionId = 'recovery-test-' + randomUUID()
  const realFetch = globalThis.fetch
  const check = { name: 'execute_command', args: { command: 'python3 probe.py 2>&1 | tail -20', profile: 'none' } }
  const calls = [
    { name: 'write_file', args: { path: 'probe.py', content: "print('starting check')\nraise ValueError('first')\n" } },
    // Leave stderr separate on the first failure to exercise the adapter bug.
    { name: 'execute_command', args: { command: 'python3 probe.py | tail -20', profile: 'none' } },
    check,
    { name: 'edit_file', args: { path: 'probe.py', old: "ValueError('first')", new: "TypeError('second')" } }, // refused by the gate
    { name: 'read_file', args: { path: 'probe.py' } },
    { name: 'execute_command', args: { command: 'python3 probe.py', purpose: 'diagnostic', profile: 'none' } },
    { name: 'diagnose_failure', args: { evidenceIds: [5, 6], cause: 'The inspected fixture deliberately raises ValueError after its progress print', nextCheck: 'Remove that fixture exception and rerun the same Python check' } },
    { name: 'edit_file', args: { path: 'probe.py', old: "raise ValueError('first')", new: "print('passed')" } },
    ...Array.from({ length: 3 }, () => ({ name: 'read_file', args: { path: 'probe.py' } })),
    { name: 'verify_work', args: { command: check.args.command, label: 'Fixture reaches final output', kind: 'test', assertions: [{ type: 'contains', value: 'passed' }] } },
  ]
  const bodies = []
  let i = 0
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/chat$/)
    bodies.push(JSON.parse(init.body))
    const call = calls[i++]
    return { ok: true, json: async () => ({ message: call
      ? { content: '', tool_calls: [{ function: { name: call.name, arguments: call.args } }] }
      : { content: 'Fixture checks passed.' }, done_reason: 'stop' }) }
  }
  try {
    const result = await run({ prompt: 'Check fixture', model: 'test-only', projectPath, sessionId })
    assert.equal(result.toolSteps.length, calls.length)
    assert.equal(result.toolSteps[1].exitCode, 1, 'tail must not hide Python failure')
    const observations = bodies.flatMap((b) => b.messages).map((m) => m.content).join('\n')
    assert.match(observations, /starting check[\s\S]*Stderr:\n[\s\S]*ValueError: first/)
    assert.match(observations, /Diagnostic checkpoint/)
    assert.equal(result.toolSteps.filter((s) => s.tool === 'read_file' && s.ok).length, 4)
    assert.ok(result.toolSteps.every((s) => s.target !== 'loop-guard'))
    assert.equal(result.toolSteps[3].ok, false, 'speculative patch must be refused')
    assert.match(result.content, /Nexus verification record/)
    assert.equal(result.toolSteps.at(-1).exitCode, 0)
    assert.match(result.toolSteps.at(-1).stdout, /passed/)
  } finally {
    globalThis.fetch = realFetch
    await fs.rm(projectPath, { recursive: true, force: true })
    await fs.rm(path.join('/tmp/nexus_sandbox', sessionId), { recursive: true, force: true })
  }
})

test('a misspelled mounted project is rejected instead of silently created', {
  skip: process.platform !== 'linux' || process.env.NEXUS_SANDBOX_TESTS !== '1',
}, async () => {
  const sessionId = 'missing-project-' + randomUUID()
  const projectPath = '/tmp/nexus-nonexistent-' + randomUUID()
  try {
    const result = await executeInSandbox({ sessionId, projectPath, language: 'bash', code: 'pwd' })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /does not exist/)
    await assert.rejects(fs.stat(projectPath), { code: 'ENOENT' })
  } finally { await fs.rm(path.join('/tmp/nexus_sandbox', sessionId), { recursive: true, force: true }) }
})
