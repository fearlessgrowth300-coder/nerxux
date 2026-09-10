import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GRAVEYARD_FILE = path.join(__dirname, '../.chat-jobs-graveyard.json')

// In-memory store for async chat jobs (see POST /api/chat with `async: true`).
// One PM2 process serves the app, so a Map is enough; jobs are short-lived.
//
// Two housekeeping rules, both driven by polling:
// - A running job nobody has polled for STALE_MS is aborted — the user closed
//   the tab or resent, and the CPU-bound local model shouldn't keep generating
//   for a reply nobody will read.
// - Finished jobs are kept for RESULT_TTL_MS so a poll that raced the
//   completion (or a retried poll) can still pick the result up, then dropped.
// Generous: a phone that locks its screen stops polling entirely, and a long
// build must survive that — the client re-attaches to the job when it comes
// back. Stop is explicit (cancelJob); this only catches truly abandoned jobs.
// Must exceed the longest a single turn is allowed to run (60 min on the GPU),
// or unattended work is killed by the polling heuristic before the model is
// even out of time — exactly the case where nobody is watching: the phone is
// locked, the PC is off, and a long build is running on the server.
export const STALE_MS = 70 * 60_000
export const RESULT_TTL_MS = 10 * 60_000

const jobs = new Map()

// A finished reply nobody collected used to be dropped after RESULT_TTL_MS and
// lost for good, because only the CLIENT writes replies to the conversation.
// Close the app while something is generating, come back an hour later, and
// the answer never existed. This hands an uncollected result somewhere durable
// before it is discarded.
let rescueUndelivered = null
export function setRescueHandler(fn) { rescueUndelivered = fn }

// A deploy restarts the process; that wipes this whole in-memory Map, no
// matter how gracefully we shut down — there's no way to actually resume a
// generation across it. What we CAN fix: right now a client polling for a
// job the old process was still running gets a bare "not found", which the
// route turns into a generic "expired" — indistinguishable from a bogus id
// or genuine staleness, and it looks like a bug in whatever the job was
// doing (nothing to do with git/Supabase/etc). Record still-running jobs to
// disk on shutdown and read them once on startup, so the very next poll
// gets an honest, specific answer instead.
const graveyard = new Map() // id -> userId
// Exported for tests — production just calls it once at import time, below.
export function loadGraveyard() {
  try {
    for (const { id, userId } of JSON.parse(fs.readFileSync(GRAVEYARD_FILE, 'utf8'))) graveyard.set(id, userId)
    fs.unlinkSync(GRAVEYARD_FILE) // one-shot — only the immediately-next poll needs this
  } catch {}
}
loadGraveyard()

// Called on SIGTERM/SIGINT (see index.js) just before the process exits.
export function saveGraveyard() {
  const running = [...jobs.values()].filter((j) => j.status === 'running').map((j) => ({ id: j.id, userId: j.userId }))
  if (!running.length) return
  try { fs.writeFileSync(GRAVEYARD_FILE, JSON.stringify(running)) } catch {}
}

export function createJob(userId, controller, now = Date.now(), conversationId = null) {
  const job = {
    id: randomUUID(),
    userId,
    conversationId,
    delivered: false,
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
  if (job) {
    if (job.userId !== userId) return null
    job.lastSeen = now
    return job
  }
  if (graveyard.get(id) === userId) {
    return {
      status: 'error',
      error: 'The server restarted while this was still working (a deploy). ' +
        'Resend the same message in this chat to pick up where it left off — any files or commits it already made are still there.',
    }
  }
  return null
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
      if (!job.delivered && job.status === 'done' && job.conversationId && rescueUndelivered) {
        Promise.resolve(rescueUndelivered(job)).catch(() => {})
      }
      jobs.delete(job.id)
    }
  }
}

// What is this user still running? localStorage is not a reliable record of
// that — it can be cleared, raced on load, or simply belong to another device
// — but the server always knows. Lets a reloaded page re-attach to its own
// work instead of losing sight of a job that is still going.
export function listRunningJobs(userId) {
  return [...jobs.values()]
    .filter((j) => j.userId === userId && j.status === 'running')
    .map((j) => ({ jobId: j.id, conversationId: j.conversationId || null, startedAt: j.createdAt }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function jobCount() {
  return jobs.size
}

const sweeper = setInterval(sweepJobs, 15_000)
sweeper.unref() // never keep the process alive just for housekeeping
