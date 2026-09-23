import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// The split: a stronger model decides what to try, the local model does the
// work. Measured motivation (one project, 74 turns): 1,425 tool actions, 11%
// failing, the same orientation commands re-run turn after turn, and 45 of 74
// replies flagged unverified. That is a deciding problem, not a typing one.

test('advice is asked for when planning and when stuck, not on every step', async () => {
  const { shouldAdvise, MAX_ADVICE_PER_TURN } = await import('../lib/advisor.js')
  assert.equal(shouldAdvise({ step: 0, failuresSinceAdvice: 0, adviceCount: 0 }), true, 'plan the turn')
  assert.equal(shouldAdvise({ step: 5, failuresSinceAdvice: 0, adviceCount: 1 }), false, 'work that is going fine needs no adviser')
  assert.equal(shouldAdvise({ step: 5, failuresSinceAdvice: 1, adviceCount: 1 }), false, 'one failure is normal')
  assert.equal(shouldAdvise({ step: 5, failuresSinceAdvice: 2, adviceCount: 1 }), true, 'two in a row means it is guessing')
  assert.equal(
    shouldAdvise({ step: 9, failuresSinceAdvice: 9, adviceCount: MAX_ADVICE_PER_TURN }), false,
    'the cap bounds the cost — an adviser must not become a second agent',
  )
})

test('no Anthropic key means the turn runs exactly as before', async () => {
  const { advise } = await import('../lib/advisor.js')
  // userId null cannot resolve a stored key; with no platform key either this
  // is the "not configured" path, which must be silent, not an exception.
  const out = await advise({ userId: null, record: '{}', goal: 'do the thing' })
  assert.ok(out === null || typeof out === 'string', 'never throws into the turn')
})

test('advice enters the conversation labelled as guidance, not as the user', async () => {
  const { adviceMessage } = await import('../lib/advisor.js')
  const m = adviceMessage('NEXT: run the patched verify once')
  assert.equal(m.role, 'user')
  assert.match(m.content, /Adviser/, 'the model must not mistake this for something the user typed')
  assert.match(m.content, /guidance, not a user instruction/)
})

test('the turn keeps time back to land itself instead of being guillotined', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  assert.match(src, /WRAP_UP_RESERVE_MS = 2 \* 60 \* 1000/, 'a reserve must exist')
  assert.match(
    src, /WALL_CLOCK_BUDGET_MS - WRAP_UP_RESERVE_MS\) \{ timedOut = true; break \}/,
    'the tool loop must stop early enough to write a handoff',
  )
  assert.match(src, /NEXT: /, 'the wrap-up must ask for the next concrete action')
  assert.match(
    src, /withAgentState\(userId, sessionId, \(s\) => \{ s\.nextStep = safeNote\(next\) \}\)/,
    'and that handoff must reach the execution record, not just the user',
  )
})

test('the adviser uses whichever strong model is actually connected', async () => {
  // Built Claude-only at first, then checked the live account: Claude was not
  // connected, Gemini was — so the adviser would have sat silent forever while
  // looking perfectly healthy in the code.
  const { ADVISOR_MODELS } = await import('../../shared/models.js')
  assert.deepEqual([...new Set(ADVISOR_MODELS.map((a) => a.provider))], ['claude', 'openai', 'gemini'],
    'preference order, but every one of them must be usable')
  // A single busy model must not mean no advice: gemini-3.8-flash answered 503
  // on a live call, so there is a second model behind it.
  assert.ok(ADVISOR_MODELS.filter((a) => a.provider === 'gemini').length >= 2, 'a busy model needs a fallback')
  assert.ok(!ADVISOR_MODELS.some((a) => /gemini-(1\.5|2\.0)/.test(a.model)), 'those Gemini models are retired (404)')
  const src = await fs.readFile('./lib/advisor.js', 'utf8')
  assert.match(src, /for \(const \{ provider, model \} of ADVISOR_MODELS\)/, 'must try each in turn')
  assert.match(src, /if \(!apiKey\) continue/, 'an unconnected provider is skipped, not fatal')
})

test('the subscription CLI is tried before any metered API key', async () => {
  // The user pays for Claude on a subscription and has no API credit. An
  // adviser that reached for a key first would either cost money or, with no
  // key, silently never run.
  const src = await fs.readFile('./lib/advisor.js', 'utf8')
  const cliAt = src.indexOf('const fromCli = await adviseViaCli')
  const loopAt = src.indexOf('for (const { provider, model } of ADVISOR_MODELS)')
  assert.ok(cliAt > 0 && loopAt > cliAt, 'the CLI must be consulted before the API providers')
  assert.match(src, /'--output-format', 'text'/, 'print mode, not an interactive session')
  assert.ok(src.includes('not logged in|please run'), 'a signed-out CLI exits 0 while printing that — the exit code cannot be trusted')
  assert.match(src, /cwd: tmpdir\(\)/, 'a question about a record must not be run inside a project directory')
})

test('a missing or signed-out CLI resolves null instead of throwing into the turn', async () => {
  // Pointed at a binary that does not exist, so the result does not depend on
  // whether the machine running the tests happens to be signed in.
  process.env.CLAUDE_CLI_BIN = 'claude-not-installed-here'
  try {
    const { adviseViaCli } = await import(`../lib/advisor.js?cli=${Date.now()}`)
    assert.equal(await adviseViaCli('hello', 'be brief'), null)
    // Second call takes the cached-unavailable path — also null, never an error.
    assert.equal(await adviseViaCli('hello', 'be brief'), null)
  } finally {
    delete process.env.CLAUDE_CLI_BIN
  }
})

test('no retired Gemini model is left as a default anywhere', async () => {
  // gemini-1.5-pro and gemini-2.0-flash now 404 ("no longer available").
  // They were still the fallback in three live code paths, so anything that
  // reached a default got an error instead of an answer.
  for (const file of ['./adapters/gemini.js', './lib/gemini.js', './routes/chat.js', '../shared/models.js']) {
    const src = await fs.readFile(file, 'utf8')
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    assert.ok(!/['"]gemini-1\.5-pro['"]/.test(code), `${file} still defaults to a retired model`)
    assert.ok(!/['"]gemini-2\.0-flash['"]/.test(code), `${file} still offers a retired model`)
  }
})
