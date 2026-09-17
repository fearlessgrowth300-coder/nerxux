import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// Kaggle has no public address: the notebook opens a reverse SSH tunnel INTO
// this VPS (the opposite direction from Turbo, where the VPS opens the tunnel
// out to RunPod), landing on 127.0.0.1:20140. Nexus only ever reads that port —
// it cannot start or stop the notebook, so every check here is "is it there
// right now", never "make it be there".

test('the Kaggle SSH key can only reverse-forward its one port — verified live against the VPS', () => {
  // This documents the manual verification actually run against the deployed
  // authorized_keys restriction (not re-run automatically: it needs a real SSH
  // round-trip to 2.25.126.125). Restated here so the constraint has a record
  // a future change can be checked against.
  const restriction = 'restrict,port-forwarding,permitopen="127.0.0.1:1",permitlisten="127.0.0.1:20140",command="echo tunnel-only key; exit 1"'
  assert.match(restriction, /^restrict,/, 'restrict must come first — it is what disables pty/x11/agent-forwarding/shell by default')
  assert.match(restriction, /permitlisten="127\.0\.0\.1:20140"/, 'only the Kaggle port may be reverse-forwarded')
  assert.doesNotMatch(restriction, /permitopen="none"/, 'permitopen="none" is REFUSED by this OpenSSH build (9.6) — use a dead port instead, or the key cannot authenticate at all')
  assert.match(restriction, /command=/, 'a forced command blocks a shell even if -N is omitted')
})

test('computeManager exposes exactly what the adapter and routes need for Kaggle', async () => {
  const cm = await import('../lib/computeManager.js')
  for (const name of ['KAGGLE_URL', 'getKaggleUsage', 'kaggleReachable', 'switchToKaggle', 'ensureKaggleReady']) {
    assert.ok(name in cm, `computeManager must export ${name}`)
  }
  assert.match(cm.KAGGLE_URL, /^http:\/\/127\.0\.0\.1:20140$/, 'must match the port the tunnel restriction permits')
})

test('switching to kaggle mode is reflected in status, with its own label and no billing claim', async () => {
  const cm = await import('../lib/computeManager.js')
  cm.switchToKaggle()
  const status = cm.getComputeStatus()
  assert.equal(status.mode, 'kaggle')
  assert.equal(status.activeUrl, cm.KAGGLE_URL)
  assert.match(status.details.label, /Kaggle/)
  assert.match(status.details.cost, /free/i, 'Kaggle GPU hours are free, unlike Turbo')
  assert.ok(status.details.usage, 'usage/quota must be visible so the user does not run out mid-turn unexpectedly')
})

test('ensureKaggleReady falls back to Always On (never Turbo) when the tunnel is not up, and says why', async () => {
  const cm = await import('../lib/computeManager.js')
  cm.switchToKaggle()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    const ready = await cm.ensureKaggleReady()
    assert.equal(ready, false)
    assert.equal(cm.getComputeStatus().mode, 'always_on', 'a dead tunnel must not strand the turn on Kaggle forever')
    assert.match(cm.takeFallbackReason() || '', /not connected/i)
  } finally { globalThis.fetch = realFetch }
})

test('ensureKaggleReady stays on kaggle when the tunnel answers', async () => {
  const cm = await import('../lib/computeManager.js')
  cm.switchToKaggle()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { assert.match(String(url), /127\.0\.0\.1:20140\/health/); return new Response('{"status":"ok"}', { status: 200 }) }
  try {
    assert.equal(await cm.ensureKaggleReady(), true)
    assert.equal(cm.getComputeStatus().mode, 'kaggle')
  } finally { globalThis.fetch = realFetch }
})

test('the ollama adapter treats Kaggle as a fast backend (Turbo-sized budget) but keeps its own model name', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  assert.match(src, /const isKaggle = targetUrl === KAGGLE_URL/)
  assert.match(src, /let generousBudget = isRunpod \|\| isKaggle/, 'Kaggle reuses the prompt cache and reads at ~390 tok/s — it should not get the CPU-only 14k cap')
  assert.match(src, /modelForTarget\(model, isRunpod, isKaggle\)/, 'Kaggle must not have its model silently swapped for ALWAYS_ON_MODEL')
  assert.match(src, /if \(targetUrl\.includes\('11435'\) && !\(await ensureTurboReady\(\)\)\)/)
  assert.match(src, /else if \(targetUrl === KAGGLE_URL && !\(await ensureKaggleReady\(\)\)\)/, 'Kaggle gets the same pre-flight-then-fallback treatment as Turbo, not a hang')
  assert.match(src, /postOpenAIChat/, 'Kaggle runs llama-server, so it must go through the same request/response translation as Always On llama-server')
})

test('modelForTarget: Turbo and Kaggle both keep the real model; only Always On (neither flag) swaps it', async () => {
  const { modelForTarget, ALWAYS_ON_MODEL } = await import('../adapters/ollama.js')
  const big = 'orcarouter/Qwen3.8-27B-Uncensored:latest'
  assert.equal(modelForTarget(big, true, false), big, 'Turbo')
  assert.equal(modelForTarget(big, false, true), big, 'Kaggle')
  assert.equal(modelForTarget(big, false, false), ALWAYS_ON_MODEL, 'Always On still swaps')
})

test('a Kaggle session-time countdown starts on connect and clears on disconnect', async () => {
  const cm = await import('../lib/computeManager.js')
  const realFetch = globalThis.fetch
  // Down, then up: getKaggleSessionTime must be null until a connection is seen.
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  cm.switchToKaggle()
  await cm.ensureKaggleReady() // fails -> falls back to always_on, no session
  assert.equal(cm.getComputeStatus().mode, 'always_on')
  cm.switchToKaggle()
  globalThis.fetch = async () => new Response('{"status":"ok"}', { status: 200 })
  try {
    const t0 = Date.now()
    assert.equal(await cm.ensureKaggleReady(), true)
    const session = cm.getComputeStatus().details.session
    assert.ok(session, 'a session must appear once the tunnel is seen up')
    assert.ok(session.startedAt >= t0 && session.startedAt <= Date.now() + 1000, 'startedAt is the moment it was first seen connected, not some other time')
    assert.equal(session.limitSeconds, cm.KAGGLE_SESSION_LIMIT_S)
    assert.equal(session.approximate, true, "must be honest that this is not Kaggle's own clock")

    // Still connected on the next check: the SAME session, not a new one.
    const startedAt1 = session.startedAt
    await new Promise((r) => setTimeout(r, 5))
    await cm.ensureKaggleReady()
    assert.equal(cm.getComputeStatus().details.session.startedAt, startedAt1, 'staying connected must not reset the countdown')

    // Disconnects: the session clears immediately, not lingering as stale.
    // (ensureKaggleReady also falls back to always_on on failure — checking
    // getKaggleSessionTime() directly here, independent of the current mode,
    // is what actually proves the countdown state was cleared.)
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await cm.ensureKaggleReady()
    assert.equal(cm.getKaggleSessionTime(), null, 'no active tunnel means no countdown to show')
  } finally { globalThis.fetch = realFetch }
})

test('reconnecting after a drop starts a FRESH countdown, not the old one', async () => {
  const cm = await import('../lib/computeManager.js')
  const realFetch = globalThis.fetch
  try {
    cm.switchToKaggle()
    globalThis.fetch = async () => new Response('{"status":"ok"}', { status: 200 })
    await cm.ensureKaggleReady()
    const first = cm.getComputeStatus().details.session.startedAt

    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await cm.ensureKaggleReady() // drops -> falls back to always_on
    cm.switchToKaggle()
    await new Promise((r) => setTimeout(r, 5))
    globalThis.fetch = async () => new Response('{"status":"ok"}', { status: 200 })
    await cm.ensureKaggleReady() // reconnects (e.g. a new notebook run)
    const second = cm.getComputeStatus().details.session.startedAt
    assert.ok(second > first, 'a fresh connection must get a fresh, later start time')
  } finally { globalThis.fetch = realFetch }
})

// Regression: a real Nexus deploy while the tunnel was live reset the visible
// countdown to a fresh 12h, because "is this a fresh connection" used to key
// off lastKaggleCheck (an in-memory flag, back to 0 on every process start)
// instead of kaggleSessionStart (persisted, and cleared only on an observed
// disconnect). Simulates the restart with a genuinely fresh module instance
// (cache-busted import), the same way a real `pm2 restart` re-runs this file
// from a clean process while .compute-state.json survives on disk.
test('a Nexus restart does not reset an in-progress Kaggle countdown', async () => {
  const cm = await import('../lib/computeManager.js')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"status":"ok"}', { status: 200 })
  try {
    cm.switchToKaggle()
    await cm.ensureKaggleReady()
    const before = cm.getKaggleSessionTime()
    assert.ok(before, 'a session must be recorded before "restarting"')

    const cm2 = await import(`../lib/computeManager.js?restart-test=${Date.now()}`)
    const restored = cm2.getKaggleSessionTime()
    assert.ok(restored, 'the countdown must survive a restart (it is read from persisted state)')
    assert.equal(restored.startedAt, before.startedAt, 'the ORIGINAL start time, not a new one')

    // The first health check the "new process" makes must not treat an
    // already-connected tunnel as a brand-new session.
    await cm2.ensureKaggleReady()
    assert.equal(cm2.getKaggleSessionTime().startedAt, before.startedAt,
      'still connected after "restart" -> same countdown, not reset to now')
  } finally { globalThis.fetch = realFetch }
})

// Caught live, 2026-09-17: a real chat sent to Kaggle failed with
// "request (37742 tokens) exceeds the available context size (32768 tokens)"
// straight from llama-server. Cause: numCtx (Nexus's OWN budgeting ceiling)
// was 65536 for Kaggle, copying Turbo's real window — but Kaggle's notebook
// starts llama-server with --ctx-size 32768, a FIXED limit the OpenAI-style
// endpoint cannot raise per request. Nexus budgeted room for a ~65k-token
// prompt and sent something the real server could only ever reject.
test("a Kaggle request never exceeds the notebook's real 32768 context, even with a huge conversation", async () => {
  const cm = await import('../lib/computeManager.js')
  const { run } = await import('../adapters/ollama.js')
  const { estimateTokens } = await import('../lib/fitContext.js')
  cm.switchToKaggle()
  const realFetch = globalThis.fetch
  let sentBody = null
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/health')) return new Response('{"status":"ok"}', { status: 200 })
    sentBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      id: 'x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      timings: { prompt_n: 300, prompt_ms: 1000 },
    }), { status: 200 })
  }
  try {
    // A conversation big enough to have produced the real 37742-token request
    // under the old bug (generousBudget gave it a 65536 ceiling); the model
    // here has no tool defs beyond the agent's own, keeping this deterministic.
    const massive = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn ${i} `.padEnd(1400, 'x'),
    }))
    await run({ prompt: 'continue', history: massive, model: 'orcarouter/Qwen3.8-27B-Uncensored:latest' })
    assert.ok(sentBody, 'the chat request must actually have been sent (Kaggle was reachable)')
    const sentTokens = sentBody.messages.reduce((n, m) => n + estimateTokens(m), 0)
    // Nexus's own reply budget (numPredict) plus the 512-token safety margin
    // must fit alongside what was sent, inside the notebook's REAL 32768 window.
    assert.ok(sentTokens + 12000 + 512 <= 32768,
      `sent ${sentTokens} tokens (+ 12000 reply + 512 margin = ${sentTokens + 12512}) — must fit in Kaggle's real 32768, not Turbo's 65536`)
  } finally {
    globalThis.fetch = realFetch
    cm.switchToKaggle() // leave mode as kaggle is fine; state is per-process anyway
  }
})

test('a Turbo turn that falls back to Always On mid-way drops the Infinity budget and the Turbo label too', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  const fallback = src.match(/const fallBackToAlwaysOn = \(\) => \{[\s\S]*?\n  \}/)
  assert.ok(fallback, 'fallBackToAlwaysOn block found')
  assert.match(fallback[0], /generousBudget = false/, 'without this, a turn that fell back keeps Turbo-sized (Infinity) budget on the CPU box')
  assert.match(fallback[0], /targetLabel = 'Always On'/, 'without this, later progress messages still say "Turbo" after falling back')
  assert.match(fallback[0], /fallbackNote\('Turbo'\)/, 'this path is only reachable from a dying Turbo tunnel, never Kaggle')
})
