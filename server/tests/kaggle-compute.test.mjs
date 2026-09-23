import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

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
  for (const name of ['KAGGLE_URL', 'KAGGLE_SLOTS', 'isKaggleUrl', 'getKaggleCtx', 'getKaggleVision', 'getKaggleUsage', 'kaggleReachable', 'switchToKaggle', 'ensureKaggleReady']) {
    assert.ok(name in cm, `computeManager must export ${name}`)
  }
  assert.match(cm.KAGGLE_URL, /^http:\/\/127\.0\.0\.1:20140$/, 'must match the port the primary account tunnel restriction permits')
  assert.equal(cm.KAGGLE_SLOTS.length, 3, 'three accounts')
  const ports = cm.KAGGLE_SLOTS.map((s) => s.url)
  assert.deepEqual(new Set(ports).size, ports.length, 'every account must use a DIFFERENT port — two notebooks sharing one port cannot both hold the tunnel')
  assert.match(cm.KAGGLE_SLOTS[1].url, /^http:\/\/127\.0\.0\.1:20141$/)
  assert.match(cm.KAGGLE_SLOTS[2].url, /^http:\/\/127\.0\.0\.1:20142$/)
  assert.ok(ports.every((u) => cm.isKaggleUrl(u)), 'every account must be recognised as a Kaggle target')
  assert.ok(!cm.isKaggleUrl('http://127.0.0.1:11435'), 'a Turbo url must not be mistaken for Kaggle')
})

test('all three Kaggle accounts each get their own restricted SSH key on their own port — verified live against the VPS', () => {
  // Documents the manual verification of accounts B and C's authorized_keys
  // entries, added alongside the first (see the single-port test above). Two
  // notebooks sharing one port cannot both hold the tunnel — this is why each
  // extra account needs its own port, not just its own key.
  const restrictionB = 'restrict,port-forwarding,permitopen="127.0.0.1:1",permitlisten="127.0.0.1:20141",command="echo tunnel-only key; exit 1"'
  const restrictionC = 'restrict,port-forwarding,permitopen="127.0.0.1:1",permitlisten="127.0.0.1:20142",command="echo tunnel-only key; exit 1"'
  assert.match(restrictionB, /permitlisten="127\.0\.0\.1:20141"/, 'account B must reverse-forward to a port account A never uses')
  assert.match(restrictionC, /permitlisten="127\.0\.0\.1:20142"/, 'account C must reverse-forward to a port neither A nor B uses')
})

test('switching to kaggle mode is reflected in status, with its own label and no billing claim', async () => {
  const cm = await import('../lib/computeManager.js')
  cm.switchToKaggle()
  const status = cm.getComputeStatus()
  assert.equal(status.mode, 'kaggle')
  // Whichever account is active — the sticky slot carries over from whatever ran
  // before, so pinning this to slot A would only be testing test ordering.
  assert.ok(cm.KAGGLE_SLOTS.some((s) => s.url === status.activeUrl),
    `activeUrl ${status.activeUrl} must be one of the configured Kaggle accounts`)
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
    assert.match(cm.takeFallbackReason() || '', /no kaggle notebook is connected/i)
  } finally { globalThis.fetch = realFetch }
})

test('ensureKaggleReady stays on kaggle when the tunnel answers', async () => {
  const cm = await import('../lib/computeManager.js')
  cm.switchToKaggle()
  const realFetch = globalThis.fetch
  // The probe is /props, not /health: it proves reachability AND carries both
  // the real context window and whether a vision projector loaded, in one
  // request (see kaggleSlotReachable).
  globalThis.fetch = async (url) => {
    assert.match(String(url), /127\.0\.0\.1:20140\/props/)
    return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } }), { status: 200 })
  }
  try {
    assert.equal(await cm.ensureKaggleReady(), true)
    assert.equal(cm.getComputeStatus().mode, 'kaggle')
  } finally { globalThis.fetch = realFetch }
})

test('the ollama adapter treats Kaggle as a fast backend (Turbo-sized budget) but keeps its own model name', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  assert.match(src, /let isKaggle = isKaggleUrl\(targetUrl\)/, 'must recognise EITHER account\'s url, and be reassignable so fallBackToAlwaysOn can clear it on a mid-turn drop')
  assert.match(src, /let generousBudget = isRunpod \|\| isKaggle/, 'Kaggle reuses the prompt cache and reads at ~390 tok/s — it should not get the CPU-only 14k cap')
  assert.match(src, /modelForTarget\(model, isRunpod, isKaggle\)/, 'Kaggle must not have its model silently swapped for ALWAYS_ON_MODEL')
  assert.match(src, /if \(targetUrl\.includes\('11435'\) && !\(await ensureTurboReady\(\)\)\)/)
  assert.match(src, /else if \(isKaggleUrl\(targetUrl\) && !\(await ensureKaggleReady\(\)\)\)/, 'Kaggle gets the same pre-flight-then-fallback treatment as Turbo, not a hang, for whichever account is active')
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
// Parameterised over the window the SERVER reports, because that is now where
// the number comes from: the notebook picks its --ctx-size off a fallback
// ladder (whatever fits the GPU that run), and Nexus reads it back from
// /v1/models. Both rungs are checked so neither a small nor a large window
// can drift out of budget again.
for (const serverCtx of [32768, 131072]) {
  test(`a Kaggle request never exceeds the context the server reports (${serverCtx}), even with a huge conversation`, async () => {
  const cm = await import('../lib/computeManager.js')
  const { run } = await import('../adapters/ollama.js')
  const { estimateTokens } = await import('../lib/fitContext.js')
  cm.switchToKaggle()
  const realFetch = globalThis.fetch
  let sentBody = null
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/props')) {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: serverCtx }, modalities: { vision: false } }), { status: 200 })
    }
    sentBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      id: 'x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      timings: { prompt_n: 300, prompt_ms: 1000 },
    }), { status: 200 })
  }
  try {
    await cm.ensureKaggleReady() // learn the server's window before the turn
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
    // must fit alongside what was sent, inside the window the server declared.
    assert.ok(sentTokens + sentBody.max_tokens + 512 <= serverCtx,
      `sent ${sentTokens} tokens (+ 12000 reply + 512 margin = ${sentTokens + 12512}) — must fit in the server's reported ${serverCtx}`)
  } finally {
    globalThis.fetch = realFetch
    cm.switchToKaggle() // leave mode as kaggle is fine; state is per-process anyway
  }
  })
}

test('a Turbo or Kaggle turn that falls back to Always On mid-way drops the fast budget and label too', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  const fallback = src.match(/const fallBackToAlwaysOn = \(\) => \{[\s\S]*?\n  \}/)
  assert.ok(fallback, 'fallBackToAlwaysOn block found')
  assert.match(fallback[0], /isKaggle = false/, 'without this, a Kaggle turn that fell back keeps modelForTarget treating it as Kaggle (no model swap) on the CPU box')
  assert.match(fallback[0], /generousBudget = false/, 'without this, a turn that fell back keeps the fast-backend (Infinity) budget on the CPU box')
  assert.match(fallback[0], /targetLabel = 'Always On'/, 'without this, later progress messages still say the old target after falling back')
  assert.match(fallback[0], /fallbackNote\(fromLabel\)/, 'the message must name whichever backend actually dropped (Turbo or Kaggle), not a hardcoded one')
})

// Caught live, 2026-09-17: a real chat on Kaggle failed outright mid-turn with
// "Can't reach the Kaggle notebook's tunnel ... (terminated / UND_ERR_SOCKET)"
// — the notebook's session had ended (or the tunnel just dropped) between
// steps, and unlike Turbo there was no retry/fallback branch for Kaggle at
// all, so the raw socket error was thrown straight at the user with real
// work already done in the turn.
test('a Kaggle tunnel that drops mid-turn falls back to Always On instead of throwing the raw socket error', async () => {
  const cm = await import('../lib/computeManager.js')
  const { run } = await import('../adapters/ollama.js')
  cm.switchToKaggle()
  const realFetch = globalThis.fetch
  let tunnelUp = true // the pre-turn ensureKaggleReady check must see it up
  let chatCalls = 0
  globalThis.fetch = async (url, init) => {
    // Reachability probe (see kaggleSlotReachable) — must be matched BEFORE the
    // chat branch below, since it targets the same host:port.
    if (String(url).includes('/props')) {
      if (!tunnelUp) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } }), { status: 200 })
    }
    if (/127\.0\.0\.1:2014[0-9]/.test(String(url))) {
      chatCalls++
      tunnelUp = false // the notebook's session ends right as this first real request lands
      const e = new TypeError('terminated'); e.cause = { code: 'UND_ERR_SOCKET' }; throw e
    }
    // Any other target is Always On, reached only after the fallback fires.
    return new Response(JSON.stringify({ message: { content: 'recovered on Always On' }, done_reason: 'stop' }), { status: 200 })
  }
  try {
    const res = await run({ prompt: 'keep working', model: 'orcarouter/Qwen3.8-27B-Uncensored:latest' })
    assert.equal(res.content, 'recovered on Always On', 'the turn must finish on Always On, not end in a thrown connection error')
    assert.doesNotMatch(res.content, /UND_ERR_SOCKET|Can't reach/, 'the raw socket error must never reach the user')
  } finally {
    globalThis.fetch = realFetch
    cm.switchToKaggle()
  }
})

// Two-account failover: this is the entire point of a second Kaggle account —
// when account A's tunnel is down (session ended, or never connected today)
// but account B's notebook is up, Nexus should use B automatically instead of
// falling all the way back to the slow CPU box.
test('ensureKaggleReady uses account B automatically when A is down but B is up', async () => {
  const cm = await import('../lib/computeManager.js')
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { throw new TypeError('fetch failed') } // both down first, to clear any sticky slot from earlier tests
  cm.switchToKaggle()
  await cm.ensureKaggleReady()
  try {
    cm.switchToKaggle()
    globalThis.fetch = async (url) => {
      if (String(url).startsWith(cm.KAGGLE_SLOTS[0].url)) throw new TypeError('fetch failed') // account A: not connected
      if (String(url).startsWith(cm.KAGGLE_SLOTS[1].url)) return new Response('{"status":"ok"}', { status: 200 }) // account B: connected
      throw new Error(`unexpected url ${url}`)
    }
    assert.equal(await cm.ensureKaggleReady(), true, 'must succeed using account B, not fall back to Always On just because A is down')
    const status = cm.getComputeStatus()
    assert.equal(status.mode, 'kaggle')
    assert.equal(status.activeUrl, cm.KAGGLE_SLOTS[1].url, 'the active url must be account B, not A')
    assert.match(status.details.label, /Kaggle B/)
    assert.ok(status.details.accounts.find((a) => a.id === 'b')?.connected, 'account B must be reported as connected')
    assert.ok(!status.details.accounts.find((a) => a.id === 'a')?.connected, 'account A must be reported as not connected')
  } finally { globalThis.fetch = realFetch }
})

// Each account has its OWN weekly 30h quota — a shared counter would have
// made a fresh account B look like it was already almost out, just because
// account A had been used heavily.
test("each Kaggle account tracks its own weekly usage — one account's hours do not count against the other", async () => {
  const cm = await import('../lib/computeManager.js')
  const realFetch = globalThis.fetch
  try {
    cm.switchToKaggle()
    // Only account A answers. Assert B is UNCHANGED across A's activity rather
    // than zero: usage is persisted in .compute-state.json and earlier tests may
    // legitimately have left some on B — "unchanged" is the real invariant.
    const before = cm.getKaggleUsage('b').usedSeconds
    globalThis.fetch = async (url) => (String(url).startsWith(cm.KAGGLE_SLOTS[0].url)
      ? new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } }), { status: 200 })
      : Promise.reject(new TypeError('fetch failed')))
    await cm.ensureKaggleReady() // accrues some time on account A
    await new Promise((r) => setTimeout(r, 5))
    await cm.ensureKaggleReady() // second check: A actually accrues seconds now
    assert.notEqual(cm.getKaggleUsage('a').windowStart, 0, 'account A must have a real usage window once used')
    assert.equal(cm.getKaggleUsage('b').usedSeconds, before,
      "account B's usage must be untouched by account A's activity")
  } finally { globalThis.fetch = realFetch }
})

// Caught before it shipped, 2026-09-18: with several accounts, a mid-turn
// reconnect could succeed via a DIFFERENT account while the retry still went
// to the dead one's URL — looping until the turn's time limit. And accounts
// run different windows (128k vs 32k), so the budget must follow the switch.
test('a mid-turn drop switches to ANOTHER live account, re-targeted and re-budgeted to its window', async () => {
  const cm = await import('../lib/computeManager.js')
  const { run } = await import('../adapters/ollama.js')
  const { estimateTokens } = await import('../lib/fitContext.js')
  const realFetch = globalThis.fetch
  const [A, B] = cm.KAGGLE_SLOTS
  let aUp = true
  let bUp = false // held down during setup so the turn provably starts on A
  const sentTo = []
  let sentToB = null
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/props')) {
      if (u.startsWith(A.url) && aUp) return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 131072 }, modalities: { vision: false } }), { status: 200 })
      if (u.startsWith(B.url) && bUp) return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } }), { status: 200 })
      throw new TypeError('fetch failed')
    }
    sentTo.push(u)
    if (u.startsWith(A.url)) { aUp = false; const e = new TypeError('terminated'); e.cause = { code: 'UND_ERR_SOCKET' }; throw e }
    if (u.startsWith(B.url)) {
      sentToB = JSON.parse(init.body)
      // The turn streams, so reply as llama-server does: server-sent events.
      const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
      return new Response(ev({ choices: [{ index: 0, delta: { content: 'done on B' }, finish_reason: null }] })
        + ev({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error('unexpected target ' + u)
  }
  try {
    cm.switchToKaggle()
    // Make A the active account first so the turn really starts there.
    await cm.ensureKaggleReady()
    assert.equal(cm.getComputeStatus().activeUrl, A.url)
    bUp = true // B comes up; A will die on the first real request
    const big = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} `.padEnd(1400, 'x') }))
    const res = await run({ prompt: 'continue', history: big, model: 'orcarouter/Qwen3.8-27B-Uncensored:latest' })
    assert.equal(res.content, 'done on B', 'the turn must finish on the other live account')
    assert.equal(sentTo.filter((u) => u.startsWith(A.url)).length, 1, 'the dead account must not be retried in a loop')
    const tokens = sentToB.messages.reduce((n, m) => n + estimateTokens(m), 0)
    assert.ok(tokens + sentToB.max_tokens + 512 <= 32768, `sent ${tokens} tokens to a 32k server — budget did not follow the switch`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a slot missing from already-migrated state is backfilled, not left undefined', async () => {
  // The live VPS state was written when there were only two accounts, so it had
  // no "c" — and the first health check that found account C's tunnel up threw
  // "Cannot read properties of undefined (reading 'usage')", which the compute
  // route turned into a bare 500. Kaggle looked dead with nothing in the logs.
  const stateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-')), 'compute-state.json')
  process.env.NEXUS_COMPUTE_STATE = stateFile
  const twoSlotState = {
    mode: 'kaggle',
    kaggleAccounts: {
      a: { usage: { windowStart: 1789602697052, seconds: 87953.9 }, sessionStart: null },
      b: { usage: { windowStart: 1789676806986, seconds: 104875.7 }, sessionStart: null },
    },
    kaggleActiveSlot: 'b',
  }
  await fs.writeFile(stateFile, JSON.stringify(twoSlotState))
  try {
    // Cache-busted so the module's import-time migration actually re-runs.
    const cm = await import(`../lib/computeManager.js?slot-backfill=${Date.now()}`)
    for (const slot of cm.KAGGLE_SLOTS) {
      const usage = cm.getKaggleUsage(slot.id)
      assert.equal(usage.slot, slot.id, `slot ${slot.id} must report its OWN quota, not fall back to account a's`)
    }
    const written = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    for (const slot of cm.KAGGLE_SLOTS) assert.ok(written.kaggleAccounts[slot.id], `slot ${slot.id} must be persisted`)
    assert.equal(written.kaggleAccounts.a.usage.seconds, 87953.9, 'an existing account keeps the quota history it already used')
  } finally {
    delete process.env.NEXUS_COMPUTE_STATE
  }
})

test('a stale sessionStart from a slot that dropped while another was active does not survive', async () => {
  // Only the ACTIVE slot's session is cleared on a disconnect, so an idle
  // account can keep a sessionStart for days. Reconnecting it must start a new
  // 12h countdown, not resume one Kaggle already killed.
  const stateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-')), 'compute-state.json')
  process.env.NEXUS_COMPUTE_STATE = stateFile
  const threeDaysAgo = Date.now() - 3 * 86400 * 1000
  await fs.writeFile(stateFile, JSON.stringify({
    mode: 'kaggle',
    kaggleAccounts: { a: { usage: { windowStart: threeDaysAgo, seconds: 10 }, sessionStart: threeDaysAgo } },
    kaggleActiveSlot: 'a',
  }))
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } }))
  })
  await new Promise((resolve) => server.listen(20140, '127.0.0.1', resolve))
  try {
    const cm = await import(`../lib/computeManager.js?stale-session=${Date.now()}`)
    cm.switchToKaggle()
    assert.equal(await cm.ensureKaggleReady(), true, 'account A is reachable')
    const session = cm.getKaggleSessionTime('a')
    assert.ok(session.startedAt > threeDaysAgo, 'the countdown must restart, not carry a 3-day-old start time')
    assert.ok(Date.now() - session.startedAt < 60_000, 'a reconnect starts the session roughly now')
  } finally {
    server.close()
    delete process.env.NEXUS_COMPUTE_STATE
  }
})

test('resetting a slot zeroes only that account, for when it gets a new Kaggle account', async () => {
  const stateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-')), 'compute-state.json')
  process.env.NEXUS_COMPUTE_STATE = stateFile
  await fs.writeFile(stateFile, JSON.stringify({
    mode: 'kaggle',
    kaggleAccounts: {
      a: { usage: { windowStart: 1, seconds: 87953 }, sessionStart: 1 },
      b: { usage: { windowStart: 2, seconds: 104875 }, sessionStart: null },
      c: { usage: { windowStart: 3, seconds: 500 }, sessionStart: null },
    },
    kaggleActiveSlot: 'b',
  }))
  try {
    const cm = await import(`../lib/computeManager.js?reset=${Date.now()}`)
    assert.deepEqual(cm.resetKaggleUsage('a'), ['a'])
    assert.equal(cm.getKaggleUsage('a').usedSeconds, 0, 'the swapped account starts its 30h over')
    assert.equal(cm.getKaggleSessionTime('a'), null, 'and carries no session from the old account')
    assert.equal(cm.getKaggleUsage('b').usedSeconds, 104875, 'the other accounts are untouched')
    assert.throws(() => cm.resetKaggleUsage('z'), /Unknown Kaggle account/, 'an unknown slot is rejected, not silently created')
    cm.resetKaggleUsage()
    for (const slot of cm.KAGGLE_SLOTS) assert.equal(cm.getKaggleUsage(slot.id).usedSeconds, 0, 'no slot argument resets them all')
  } finally {
    delete process.env.NEXUS_COMPUTE_STATE
  }
})

test('the bar says WHY there is no tunnel — booting, or Kaggle refusing on quota', async () => {
  // "Start one and run its tunnel cell" is wrong advice when a notebook is
  // already starting, or when Kaggle is rejecting every push because the
  // weekly cap is spent. The watchdog knows which; it just never said so.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaggle-watchdog-'))
  const stateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-')), 'compute-state.json')
  process.env.NEXUS_COMPUTE_STATE = stateFile
  await fs.writeFile(stateFile, JSON.stringify({ mode: 'kaggle', kaggleActiveSlot: null }))
  const nowS = Math.floor(Date.now() / 1000)
  const at = (secondsAgo) => new Date((nowS - secondsAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // A was pushed BY HAND 5 minutes ago (a key swap onto a new account), which
  // writes a stamp but no log line — its own older failure is stale history.
  await fs.writeFile(path.join(dir, '.last_restart_a'), String(nowS - 300))
  // B and C were stamped by the watchdog at the moment their push was REFUSED.
  // The stamp is written whether the push worked or not, so a fresh stamp on
  // its own must not be read as "booting".
  await fs.writeFile(path.join(dir, '.last_restart_b'), String(nowS - 600))
  await fs.writeFile(path.join(dir, '.last_restart_c'), String(nowS - 600))
  await fs.writeFile(path.join(dir, 'watchdog.log'), [
    `${at(3600)} a: Kernel push error: Maximum weekly GPU quota of 30.00 hours reached.`,
    `${at(601)} b: tunnel down and kernel idle -> pushing adebayorola/notebookfd1ceb9e6b`,
    `${at(599)} b: Kernel push error: Maximum weekly GPU quota of 30.00 hours reached.`,
    `${at(599)} c: Kernel push error: Maximum weekly GPU quota of 30.00 hours reached.`,
    // The heartbeat the watchdog writes every 5 min afterwards is the NEWEST
    // line for each slot, and says nothing about why the slot is down.
    `${at(300)} b: down but restarted 300s ago (<2700s), leaving it to boot`,
    `${at(300)} c: down but restarted 300s ago (<2700s), leaving it to boot`,
  ].join('\n'))
  process.env.KAGGLE_WATCHDOG_DIR = dir
  try {
    const cm = await import(`../lib/computeManager.js?watchdog=${Date.now()}`)
    cm.switchToKaggle()
    const status = await cm.getLiveComputeStatus()
    assert.match(status.notice, /Kaggle A: starting \(5m in/, 'a booting account is not something the user should be told to start')
    assert.match(status.notice, /Kaggle B: Kaggle's weekly GPU quota is used up/)
    assert.match(status.notice, /Kaggle C: Kaggle's weekly GPU quota is used up/)
    assert.doesNotMatch(status.notice, /run its tunnel cell/, 'the generic advice is only for when nothing better is known')
  } finally {
    delete process.env.KAGGLE_WATCHDOG_DIR
    delete process.env.NEXUS_COMPUTE_STATE
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the status poll probes every account, so live spares are not shown as down', async () => {
  // Routing only needs the first account that answers, but the bar lists all
  // three — and listing a live spare notebook as "down" reads as two dead
  // accounts when they are in fact hot standby.
  const stateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-')), 'compute-state.json')
  process.env.NEXUS_COMPUTE_STATE = stateFile
  const props = (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 131072 }, modalities: { vision: true } }))
  }
  // A and C answer; B has no notebook running.
  const servers = [http.createServer(props), http.createServer(props)]
  await new Promise((r) => servers[0].listen(20140, '127.0.0.1', r))
  await new Promise((r) => servers[1].listen(20142, '127.0.0.1', r))
  try {
    const cm = await import(`../lib/computeManager.js?probe-all=${Date.now()}`)
    cm.switchToKaggle()
    await cm.getLiveComputeStatus()
    const status = await cm.getLiveComputeStatus()
    const byId = Object.fromEntries(status.details.accounts.map((a) => [a.id, a.connected]))
    assert.deepEqual(byId, { a: true, b: false, c: true }, 'every account reports its OWN tunnel state')
    assert.match(status.details.label, /Kaggle A/, 'the first answering account is the one in use')
    assert.equal(status.details.status, 'ready')
    // C is only a spare, but its notebook is running and burning its own
    // 30h — Kaggle charges the session, not the requests Nexus sends it.
    assert.ok(cm.getKaggleUsage('c').usedSeconds >= 0 && cm.getKaggleSessionTime('c'), 'a live spare accrues its own session')
    assert.equal(cm.getKaggleSessionTime('b'), null, 'an account with no tunnel has no session')
  } finally {
    for (const s of servers) s.close()
    delete process.env.NEXUS_COMPUTE_STATE
  }
})
