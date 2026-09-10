import { api, apiError } from './api'

const POLL_MS = 2000
// A single poll can fail for reasons that have nothing to do with the job
// (a blip at the proxy, a flaky connection) — don't throw the whole reply
// away for one of those, only for a run of them.
const MAX_POLL_FAILURES = 5

// Wait for the next poll — but if the page comes back from the background
// (phone unlocked, tab re-focused) poll immediately instead of finishing a
// throttled timer, so the answer shows the moment the user looks.
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function onVisible() { if (document.visibilityState === 'visible') done() }
    function done() { clearTimeout(timer); document.removeEventListener?.('visibilitychange', onVisible); resolve() }
    document.addEventListener?.('visibilitychange', onVisible)
  })
}

// Polls an existing job to completion. Used by sendChat, and by the chat page
// to re-attach to a job that was in flight when the app was closed/reloaded.
// Jobs still running server-side for this user.
export async function listRunningJobs() {
  const { data } = await api.get('/api/chat/jobs')
  return data.jobs || []
}

export async function pollJob(jobId, { signal, onProgress } = {}) {
  const stop = () => api.post(`/api/chat/jobs/${jobId}/cancel`).catch(() => {})
  signal?.addEventListener('abort', stop, { once: true })
  try {
    if (signal?.aborted) { stop(); throw new Error('Stopped.') }
    let failures = 0
    for (;;) {
      await sleep(POLL_MS)
      if (signal?.aborted) throw new Error('Stopped.')
      let job
      try {
        job = (await api.get(`/api/chat/jobs/${jobId}`)).data
        failures = 0
      } catch (err) {
        // 404 = the server really doesn't have it (restart/expiry) — that's final.
        if (err?.response?.status === 404 || ++failures >= MAX_POLL_FAILURES) throw err
        continue
      }
      if (job.status === 'running') { if (job.events?.length) onProgress?.(job.events); continue }
      if (job.status === 'cancelled') throw new Error('Stopped.')
      if (job.status !== 'done') throw new Error(job.error || 'Chat request failed')
      return { messages: job.result.messages, routing: job.result.routing || null }
    }
  } catch (err) {
    throw apiError(err, 'Chat request failed')
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

// Sends the conversation + options to the backend.
// Returns { messages: [...], routing?: {...} }.
//
// The backend runs the request as a job and we poll for the result: the
// hosting proxy in front of the API drops any single request after ~120s,
// and slow models (the CPU-hosted local one especially) routinely need
// longer than that for a real answer. Polling keeps every request short.
// `signal`: abort to stop generation (the Stop button) — the server job is
// cancelled, not just the polling. `onProgress(events)`: called with the
// agent's live activity (tool actions, interim text) on every poll.
export async function sendChat({
  history,
  modelA,
  modelB,
  pipeline,
  systemPrompt,
  videoContext,
  auto = false,
  attachments,
  webSearch,
  agentTools,
  connectorIds,
  sessionId,
  projectPath,
  signal,
  onProgress,
  onJob, // called with the job id as soon as the server hands one back
}) {
  try {
    const { data } = await api.post('/api/chat', {
      history,
      modelA,
      modelB,
      pipeline,
      systemPrompt,
      videoContext,
      auto,
      attachments,
      webSearch,
      agentTools,
      connectorIds,
      sessionId,
      projectPath,
      async: true,
    })
    // An older backend answers inline instead of handing back a job.
    if (!data.jobId) return { messages: data.messages, routing: data.routing || null }
    onJob?.(data.jobId)
    return await pollJob(data.jobId, { signal, onProgress })
  } catch (err) {
    throw apiError(err, 'Chat request failed')
  }
}

// Continues a paused turn after the user approves/denies tools.
// decisions: { [toolUseId]: 'approve' | 'deny' }
export async function resumeChat(pendingId, decisions) {
  try {
    const { data } = await api.post('/api/chat/resume', { pendingId, decisions })
    return data.messages
  } catch (err) {
    throw apiError(err, 'Resume failed')
  }
}

