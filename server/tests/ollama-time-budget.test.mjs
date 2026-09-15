import test from 'node:test'
import assert from 'node:assert/strict'

// 2026-09-15: on Always On one agent step took 63 minutes (a 22k-token prompt
// re-read from zero at CPU speed), ran straight past the 25-minute budget, then
// started a no-tools summary that would have re-read everything again. The chat
// sat on "Thinking…" for hours. These pin the fixes.
const { run, estimateReadSeconds, WRAPUP_MAX_READ_S, modelForTarget, ALWAYS_ON_MODEL, readSecondsFor, learnReadSpeed, resetReadSpeeds } = await import('../adapters/ollama.js')
// A dense model with no learned speed: held to the 27B's measured read times.
const DENSE = 'some-dense-model'
const { createJob, sweepJobs, MAX_RUNTIME_MS, STALE_MS } = await import('../lib/chatJobs.js')

test('the read-time estimate matches what the Always On box measured', () => {
  // Ollama journal: 4,096 tokens in 282 s; 21,196 tokens in 3,343 s.
  const near = (got, want) => Math.abs(got - want) / want < 0.1
  assert.ok(near(estimateReadSeconds(4096, false), 282), `4k tokens: ${estimateReadSeconds(4096, false)} s`)
  assert.ok(near(estimateReadSeconds(21196, false), 3343), `21k tokens: ${estimateReadSeconds(21196, false)} s`)
  assert.ok(estimateReadSeconds(21196, true) < 60, 'Turbo reads the same prompt in well under a minute')
})

const big = 'x'.repeat(3.2 * 40_000) // ~40k tokens: far more than Always On can read in 25 min

test('Always On refuses a step it cannot read in the time left, instead of hanging for an hour', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not be called') }
  try {
    const events = []
    const res = await run({ prompt: big, model: DENSE, onProgress: (e) => events.push(e) })
    assert.equal(calls, 0, 'no request is sent to the model')
    assert.match(res.content, /Always On/)
    assert.match(res.content, /Turbo/, 'tells the user the way out')
    assert.match(res.content, /min to read/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a slow step shows why it is slow instead of a silent spinner', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'hi' }, done_reason: 'stop' }) })
  try {
    const events = []
    // ~6k tokens with the tool definitions: minutes on the CPU, allowed.
    const res = await run({ prompt: 'y'.repeat(3.2 * 3000), model: DENSE, onProgress: (e) => events.push(e) })
    assert.equal(res.content, 'hi')
    assert.ok(events.some((e) => e.type === 'text' && /reading about \d+k tokens/.test(e.text)), 'a progress note explains the wait')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the model request itself carries the turn deadline', async () => {
  const realFetch = globalThis.fetch
  let sawSignal = null
  globalThis.fetch = async (url, init) => { sawSignal = init.signal; return { ok: true, json: async () => ({ message: { content: 'ok' }, done_reason: 'stop' }) } }
  try {
    await run({ prompt: 'short' })
    assert.ok(sawSignal instanceof AbortSignal, 'a signal is always attached, even with no client signal')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a request cut off by the deadline ends the turn with a plain note, not an error', async () => {
  const realFetch = globalThis.fetch
  const realTimeout = AbortSignal.timeout
  // Make every deadline fire immediately.
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException('timed out', 'TimeoutError'))
  globalThis.fetch = async (url, init) => { if (init.signal?.aborted) throw init.signal.reason; return { ok: true, json: async () => ({ message: { content: 'late' } }) } }
  try {
    const res = await run({ prompt: 'short' })
    assert.match(res.content, /minute limit/)
    assert.match(res.content, /Send "continue"/)
  } finally {
    globalThis.fetch = realFetch
    AbortSignal.timeout = realTimeout
  }
})

test('the end-of-turn summary is skipped when re-reading the chat would be slow', () => {
  assert.ok(estimateReadSeconds(20_000, false) > WRAPUP_MAX_READ_S, 'a long Always On chat gets no summary request')
  assert.ok(estimateReadSeconds(20_000, true) <= WRAPUP_MAX_READ_S, 'Turbo still gets one')
})

test('no job can stay "running" forever, even while the client keeps polling', () => {
  const job = createJob('u-max', { abort() { job.aborted = true } }, 0)
  assert.ok(MAX_RUNTIME_MS > 60 * 60_000, 'longer than the 60-minute Turbo turn')
  // The client polls the whole time, so the unattended-job rule never applies.
  job.lastSeen = MAX_RUNTIME_MS
  sweepJobs(MAX_RUNTIME_MS - 1)
  assert.equal(job.status, 'running')
  sweepJobs(MAX_RUNTIME_MS + 1)
  assert.equal(job.status, 'error')
  assert.equal(job.aborted, true, 'the work is actually cancelled')
  assert.match(job.error, /continue/)
  assert.ok(STALE_MS < MAX_RUNTIME_MS)
})

test('Always On sends the faster model in place of the 27B; Turbo and other picks are untouched', async () => {
  for (const big of ['orcarouter/Qwen3.8-27B-Uncensored:latest', 'nexus-mine', undefined]) {
    assert.equal(modelForTarget(big, false), ALWAYS_ON_MODEL, `Always On swaps ${big}`)
  }
  assert.equal(modelForTarget('orcarouter/Qwen3.8-27B-Uncensored:latest', true), 'orcarouter/Qwen3.8-27B-Uncensored:latest', 'Turbo keeps the 27B')
  assert.equal(modelForTarget('qwen2.5-coder:7b', false), 'qwen2.5-coder:7b', 'an explicitly different model is sent as picked')
  const realFetch = globalThis.fetch
  let sent = null
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body).model; return { ok: true, json: async () => ({ message: { content: 'ok' }, done_reason: 'stop' }) } }
  try {
    const res = await run({ prompt: 'hi', model: 'orcarouter/Qwen3.8-27B-Uncensored:latest' })
    assert.equal(sent, ALWAYS_ON_MODEL)
    assert.equal(res.model, ALWAYS_ON_MODEL, 'the reply reports the model that actually answered')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the faster model is not held to the 27B read times, and speed is learned from Ollama timings', () => {
  resetReadSpeeds()
  const t = 20_000
  assert.ok(readSecondsFor(ALWAYS_ON_MODEL, false, t) < estimateReadSeconds(t, false) / 3, 'starts from its measured speed')
  // Ollama says a 4k prompt took 400 s: learn it is slower than assumed.
  learnReadSpeed(DENSE, false, 4000, { prompt_eval_count: 3900, prompt_eval_duration: 400e9 })
  assert.ok(readSecondsFor(DENSE, false, 4000) > estimateReadSeconds(4000, false), 'slower measurement raises the estimate')
  // A cache hit (few tokens actually read) must not teach it anything.
  resetReadSpeeds()
  learnReadSpeed(DENSE, false, 4000, { prompt_eval_count: 40, prompt_eval_duration: 1e9 })
  assert.equal(readSecondsFor(DENSE, false, 4000), estimateReadSeconds(4000, false))
})
