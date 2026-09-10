import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createJob, completeJob, failJob, touchJob, sweepJobs, saveGraveyard, loadGraveyard, setRescueHandler, listRunningJobs, STALE_MS, RESULT_TTL_MS,
} from '../lib/chatJobs.js'

const GRAVEYARD_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.chat-jobs-graveyard.json')

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

test('saveGraveyard records only still-running jobs, keyed to their owner', () => {
  // Other tests in this file leave their own running/finished jobs behind
  // (module-level `jobs` Map) — assert on this test's own entries, not on
  // the file being exactly these two.
  const survivor = createJob('graveyard-test-user', new AbortController(), 0)
  const finished = createJob('graveyard-test-user', new AbortController(), 0)
  completeJob(finished, { messages: [] }, 1) // already done — not the server's fault, not recorded

  saveGraveyard()
  const written = JSON.parse(fs.readFileSync(GRAVEYARD_FILE, 'utf8'))
  assert.deepEqual(written.find((w) => w.id === survivor.id), { id: survivor.id, userId: 'graveyard-test-user' })
  assert.equal(written.some((w) => w.id === finished.id), false)
  fs.unlinkSync(GRAVEYARD_FILE)
})

test('a job the graveyard remembers gets an honest, specific answer instead of a bare 404 — and only for its owner', () => {
  // Simulates the *next* process after a restart: this id was never created
  // in this test's `jobs` Map at all, only recorded (by the previous
  // process, in the real flow) in the file loadGraveyard reads on startup.
  const ghostId = 'ghost-job-id'
  fs.writeFileSync(GRAVEYARD_FILE, JSON.stringify([{ id: ghostId, userId: 'alice' }]))
  loadGraveyard()
  assert.equal(fs.existsSync(GRAVEYARD_FILE), false) // one-shot: consumed on read

  const result = touchJob(ghostId, 'alice')
  assert.equal(result.status, 'error')
  assert.match(result.error, /server restarted/i)
  assert.equal(touchJob(ghostId, 'mallory'), null) // never leaks to a different user
  assert.equal(touchJob('never-seen-anywhere', 'alice'), null) // a truly unknown id is still a plain 404

  loadGraveyard() // nothing left to read — must not throw
})

// "Can I close everything and let it keep working?" — these are the two rules
// that decide the answer.
test('an unattended job is not killed before its own time budget runs out', () => {
  const job = createJob('u1', { abort() {} }, 0)
  // A long GPU turn is allowed 60 minutes; nobody polls the whole time.
  sweepJobs(59 * 60_000)
  assert.equal(job.status, 'running', 'a 59-minute unattended job must still be alive')
  sweepJobs(71 * 60_000)
  assert.notEqual(job.status, 'running', 'but a truly abandoned one is eventually dropped')
})

test('a reply nobody collected is handed somewhere durable before it is dropped', async () => {
  const rescued = []
  setRescueHandler((job) => { rescued.push(job) })
  const job = createJob('u1', { abort() {} }, 0, 'conv-1')
  completeJob(job, { messages: [{ role: 'assistant', content: 'the finished work' }] }, 1000)

  sweepJobs(1000 + RESULT_TTL_MS + 1)
  assert.equal(rescued.length, 1, 'the uncollected result must be saved, not binned')
  assert.equal(rescued[0].conversationId, 'conv-1')
  setRescueHandler(null)
})

test('a result the client already picked up is not saved twice', () => {
  const rescued = []
  setRescueHandler((job) => { rescued.push(job) })
  const job = createJob('u1', { abort() {} }, 0, 'conv-1')
  completeJob(job, { messages: [{ role: 'assistant', content: 'x' }] }, 1000)
  job.delivered = true // what the poll route sets when it hands the result over

  sweepJobs(1000 + RESULT_TTL_MS + 1)
  assert.equal(rescued.length, 0)
  setRescueHandler(null)
})

// A reloaded page must be able to find its own work again without relying on
// localStorage, which can be cleared, raced on load, or belong to a device the
// user is no longer holding.
test('the server can say what is still running for a user', () => {
  const a = createJob('u1', { abort() {} }, 1000, 'conv-a')
  const b = createJob('u1', { abort() {} }, 2000, 'conv-b')
  createJob('u2', { abort() {} }, 3000, 'conv-c') // someone else's

  const mine = listRunningJobs('u1')
  assert.equal(mine.length, 2)
  assert.equal(mine[0].jobId, b.id, 'newest first')
  assert.equal(mine[0].conversationId, 'conv-b')
  assert.ok(mine.every((j) => j.startedAt), 'each job reports when it started')

  completeJob(b, { messages: [] }, 4000)
  assert.deepEqual(listRunningJobs('u1').map((j) => j.jobId), [a.id], 'finished jobs drop out')
})

test("one user cannot see another user's running work", () => {
  createJob('victim', { abort() {} }, 1000, 'private')
  assert.deepEqual(listRunningJobs('attacker'), [])
})
