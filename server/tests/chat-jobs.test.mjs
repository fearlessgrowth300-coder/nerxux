import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createJob, completeJob, failJob, touchJob, sweepJobs, STALE_MS, RESULT_TTL_MS,
} from '../lib/chatJobs.js'

test('a job is only visible to the user who created it', () => {
  const job = createJob('alice', new AbortController(), 1000)
  assert.equal(touchJob(job.id, 'alice', 1001)?.id, job.id)
  assert.equal(touchJob(job.id, 'bob', 1001), null)
  assert.equal(touchJob('nope', 'alice', 1001), null)
})

test('completion and failure are recorded once and expose a readable error', () => {
  const done = createJob('u', new AbortController(), 0)
  completeJob(done, { messages: [] }, 5)
  failJob(done, new Error('late'), 6) // ignored — already finished
  assert.equal(done.status, 'done')
  assert.deepEqual(done.result, { messages: [] })

  const failed = createJob('u', new AbortController(), 0)
  failJob(failed, new Error('boom'), 5)
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, 'boom')

  const aborted = createJob('u', new AbortController(), 0)
  failJob(aborted, Object.assign(new Error('x'), { name: 'AbortError' }), 5)
  assert.equal(aborted.status, 'cancelled')
})

test('a running job nobody polls is aborted; a polled one keeps running', () => {
  const abandoned = createJob('u', new AbortController(), 0)
  const watched = createJob('u', new AbortController(), 0)
  touchJob(watched.id, 'u', STALE_MS)
  sweepJobs(STALE_MS + 1)
  assert.equal(abandoned.status, 'cancelled')
  assert.equal(abandoned.controller.signal.aborted, true)
  assert.equal(watched.status, 'running')
  assert.equal(watched.controller.signal.aborted, false)
})

test('finished jobs are kept for late polls, then expire', () => {
  const job = createJob('u', new AbortController(), 0)
  completeJob(job, { messages: [] }, 10)
  sweepJobs(10 + RESULT_TTL_MS)
  assert.equal(touchJob(job.id, 'u', 11)?.status, 'done')
  sweepJobs(10 + RESULT_TTL_MS + 1)
  assert.equal(touchJob(job.id, 'u', 12), null)
})
