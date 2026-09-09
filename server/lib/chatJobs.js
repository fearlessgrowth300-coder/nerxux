import { randomUUID } from 'node:crypto'

// In-memory store for async chat jobs (see POST /api/chat with `async: true`).
// One PM2 process serves the app, so a Map is enough; jobs are short-lived.
//
// Two housekeeping rules, both driven by polling:
// - A running job nobody has polled for STALE_MS is aborted — the user closed
//   the tab or resent, and the CPU-bound local model shouldn't keep generating
//   for a reply nobody will read.
// - Finished jobs are kept for RESULT_TTL_MS so a poll that raced the
//   completion (or a retried poll) can still pick the result up, then dropped.
export const STALE_MS = 60_000
export const RESULT_TTL_MS = 10 * 60_000

const jobs = new Map()

export function createJob(userId, controller, now = Date.now()) {
  const job = {
    id: randomUUID(),
    userId,
    controller,
    status: 'running',
    result: null,
    error: null,
    // Live progress (tool actions, interim text) pushed by the adapter while
    // the job runs, so the client can show what's happening instead of dots.
    events: [],
    createdAt: now,
    lastSeen: now,
    finishedAt: null,
  }
  jobs.set(job.id, job)
  return job
}

export function completeJob(job, result, now = Date.now()) {
  if (job.status !== 'running') return
  job.status = 'done'
  job.result = result
  job.finishedAt = now
}

export function failJob(job, err, now = Date.now()) {
  if (job.status !== 'running') return
  job.status = err?.name === 'AbortError' ? 'cancelled' : 'error'
  job.error = err?.name === 'AbortError' ? 'The request was cancelled.' : (err?.message || 'Chat request failed')
  job.finishedAt = now
}

// Returns the job for polling and marks it as still being watched.
// Never returns another user's job.
export function touchJob(id, userId, now = Date.now()) {
  const job = jobs.get(id)
  if (!job || job.userId !== userId) return null
  job.lastSeen = now
  return job
}

// User pressed Stop: abort generation now. Returns false if there's no such
// running job for this user.
export function cancelJob(id, userId) {
  const job = touchJob(id, userId)
  if (!job || job.status !== 'running') return false
  job.controller.abort()
  failJob(job, Object.assign(new Error('stopped'), { name: 'AbortError' }))
  return true
}

// Abort abandoned jobs and drop expired results. Called on a timer; exported
// so it can be driven directly in tests.
export function sweepJobs(now = Date.now()) {
  for (const job of jobs.values()) {
    if (job.status === 'running' && now - job.lastSeen > STALE_MS) {
      job.controller.abort()
      failJob(job, Object.assign(new Error('abandoned'), { name: 'AbortError' }), now)
    } else if (job.status !== 'running' && now - job.finishedAt > RESULT_TTL_MS) {
      jobs.delete(job.id)
    }
  }
}

export function jobCount() {
  return jobs.size
}

const sweeper = setInterval(sweepJobs, 15_000)
sweeper.unref() // never keep the process alive just for housekeeping
