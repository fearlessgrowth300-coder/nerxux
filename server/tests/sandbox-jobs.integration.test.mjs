import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { executeInSandbox } from '../lib/sandbox.js'
import { sandboxJob } from '../lib/sandboxJobs.js'
import { webPageCode } from '../lib/webPage.js'

const linux = process.platform === 'linux' && process.env.NEXUS_SANDBOX_TESTS === '1'
test('background work survives another tool call, retains its harness, and reports real exit status', { skip: !linux, timeout: 20000 }, async () => {
  const sessionId = 'job-test-' + randomUUID()
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-job-fixture-'))
  let job
  try {
    process.env.NEXUS_PRIVATE_FIXTURE = 'must-not-inherit'
    const start = await executeInSandbox({ sessionId, projectPath, language: 'bash', background: true, code: 'sleep 2; test -z "$NEXUS_PRIVATE_FIXTURE" || exit 2; printf "completed original job\\n"; exit 7' })
    assert.equal(start.ok, true, start.stderr)
    assert.ok(start.job?.id)
    job = start.job.id
    const next = await executeInSandbox({ sessionId, projectPath, language: 'bash', code: 'printf "second command\\n"; test ! -e /workspace/project/.nexus; test ! -e /workspace/script.sh' })
    assert.equal(next.ok, true, next.stderr)
    let result
    for (let i = 0; i < 40; i++) {
      result = await sandboxJob({ sessionId, jobId: job })
      if (result.job.status !== 'running') break
      await new Promise(r => setTimeout(r, 150))
    }
    assert.equal(result.job.status, 'completed', JSON.stringify(result))
    assert.equal(result.exitCode, 7)
    assert.match(result.stdout, /completed original job/)
    assert.doesNotMatch(result.stdout, /second command/)
    assert.deepEqual(await fs.readdir(projectPath), [])
    const reader = await executeInSandbox({ sessionId, language: 'python', code: webPageCode('http://127.0.0.1/'), profile: 'full' })
    assert.equal(reader.ok, false)
    assert.match(reader.stderr, /private or local/)
  } finally {
    delete process.env.NEXUS_PRIVATE_FIXTURE
    if (job) await sandboxJob({ sessionId, jobId: job, stop: true }).catch(() => {})
    await fs.rm(projectPath, { recursive: true, force: true })
    await fs.rm(path.join('/tmp/nexus_sandbox', sessionId), { recursive: true, force: true })
  }
})

test('a background server can be stopped explicitly', { skip: !linux, timeout: 15000 }, async () => {
  const sessionId = 'job-stop-' + randomUUID()
  let job
  try {
    const start = await executeInSandbox({ sessionId, language: 'bash', background: true, code: 'sleep 2; touch /workspace/should-not-exist' })
    assert.ok(start.job?.id, start.stderr)
    job = start.job.id
    const result = await sandboxJob({ sessionId, jobId: job, stop: true })
    assert.equal(result.exitCode, 143)
    assert.equal(result.job.status, 'completed')
    await new Promise(r => setTimeout(r, 2500))
    await assert.rejects(fs.stat(path.join('/tmp/nexus_sandbox', sessionId, 'work', 'should-not-exist')), { code: 'ENOENT' })
  } finally {
    if (job) await sandboxJob({ sessionId, jobId: job, stop: true }).catch(() => {})
    await fs.rm(path.join('/tmp/nexus_sandbox', sessionId), { recursive: true, force: true })
  }
})
