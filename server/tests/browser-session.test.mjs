import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The browser is a real Chromium on the host, so what can be checked without
// one running is the wiring: which binary gets picked, what it is launched
// with, and that the agent's tools and gating are consistent.

test('picks the NEWEST chromium build, by number not by string order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-'))
  // 1243 is newer than 1234, but sorts BEFORE it lexically — the bug this
  // guards is silently launching an older browser after an update.
  for (const build of ['chromium-1234', 'chromium-1243']) {
    await fs.mkdir(path.join(root, build, 'chrome-linux64'), { recursive: true })
    await fs.writeFile(path.join(root, build, 'chrome-linux64', 'chrome'), '')
  }
  await fs.mkdir(path.join(root, 'ffmpeg-1011'), { recursive: true })
  const { findChrome } = await import('../lib/browserSession.js')
  assert.equal(findChrome(root), path.join(root, 'chromium-1243', 'chrome-linux64', 'chrome'))
  await fs.rm(root, { recursive: true, force: true })
})

test('no chromium on the host is reported, not guessed at', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-empty-'))
  const { findChrome } = await import('../lib/browserSession.js')
  assert.equal(findChrome(empty), null)
  await fs.rm(empty, { recursive: true, force: true })
})

test('the debugging port is bound to loopback only', async () => {
  // That port is unauthenticated total control of a browser holding the
  // user's logged-in sessions. Exposed on 0.0.0.0 it is a public account
  // takeover, so this is the one launch flag worth a test of its own.
  const { chromeArgs } = await import('../lib/browserSession.js')
  const args = chromeArgs({ port: 9333, profile: '/tmp/profile' })
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'), 'must never listen on a public interface')
  assert.ok(args.includes('--remote-debugging-port=9333'))
  assert.ok(args.includes('--user-data-dir=/tmp/profile'), 'a persistent profile is what keeps the user logged in between runs')
})

test('only known keys are dispatched', async () => {
  const { KEYS, pressKey } = await import('../lib/browserSession.js')
  assert.ok(KEYS.Enter.windowsVirtualKeyCode === 13 && KEYS.Enter.text === '\r', 'Enter needs a char event or forms do not submit')
  await assert.rejects(() => pressKey('F13'), /Unsupported key/, 'an unknown key must not be silently swallowed as a no-op')
})

test('the agent gets browser tools, and they never claim to take a password', async () => {
  const { AGENT_TOOL_DEFS } = await import('../lib/agentTools.js')
  const browser = AGENT_TOOL_DEFS.filter((d) => d.name.startsWith('browser_'))
  assert.deepEqual(browser.map((d) => d.name).sort(),
    ['browser_click', 'browser_fill', 'browser_key', 'browser_open', 'browser_read'])
  const fill = browser.find((d) => d.name === 'browser_fill')
  assert.match(fill.description, /[Nn]ever put a password/, 'the model must be told to hand credentials to the user, not collect them')
  const open = browser.find((d) => d.name === 'browser_open')
  assert.match(open.description, /never ask for their password/i)
})

test('browsing does not count as changing the project', async () => {
  // Every tool outside `inspections` bumps the project revision, which stales
  // every check that had already passed. Clicking a web page changes a
  // website, never the user's files.
  const src = await fs.readFile('./lib/agentControl.js', 'utf8')
  const list = src.slice(src.indexOf('const inspections'), src.indexOf('const executions'))
  for (const tool of ['browser_open', 'browser_read', 'browser_click', 'browser_fill', 'browser_key']) {
    assert.ok(list.includes(`'${tool}'`), `${tool} must not bump the project revision`)
  }
})

test('destructive and money-moving browser actions are refused unless explicitly allowed', async () => {
  // The agent runs unattended and can act inside the user's logged-in accounts.
  // A "Buy now" or "Delete account" click must go to the user, not be done for them.
  const { browserActionBlocked } = await import('../lib/agentLoop.js')
  delete process.env.NEXUS_BROWSER_AUTONOMOUS
  for (const text of ['Buy now', 'Place order', 'Confirm purchase', 'Delete account', 'Transfer', 'Withdraw funds']) {
    assert.ok(browserActionBlocked('browser_click', { text }), `should block: ${text}`)
  }
  // Ordinary navigation is untouched.
  for (const text of ['Sign in', 'Next', 'Search', 'View orders', 'Learn more']) {
    assert.equal(browserActionBlocked('browser_click', { text }), null, `should allow: ${text}`)
  }
  // A payment field is blocked too.
  assert.ok(browserActionBlocked('browser_fill', { field: 'card number for payment', value: '4111' }))
  assert.equal(browserActionBlocked('browser_fill', { field: 'search', value: 'shoes' }), null)
  // The escape hatch turns it off for someone who wants unattended action.
  process.env.NEXUS_BROWSER_AUTONOMOUS = '1'
  assert.equal(browserActionBlocked('browser_click', { text: 'Buy now' }), null, 'opt-in disables the gate')
  delete process.env.NEXUS_BROWSER_AUTONOMOUS
})
