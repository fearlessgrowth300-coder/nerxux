// A real Chromium on the Nexus host that both the agent and the user drive —
// the same browser, the same cookies. The agent searches and clicks; when a
// site wants a login the user takes over the live view, signs in by hand, and
// the agent carries on inside that session.
//
// Why not Playwright: the Chromium builds are already on the VPS (installed
// for the sandbox) and everything here is plain CDP over the WebSocket that
// Node 22 ships natively. One less dependency to keep in step with a browser
// binary that updates on its own schedule.
//
// Why headful under Xvfb rather than --headless: sign-in pages are exactly
// where headless Chrome gets challenged or silently refused, and a login the
// user cannot complete makes the whole feature pointless. Xvfb is already
// installed, so a real X display costs one process.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CDP_PORT = Number(process.env.BROWSER_CDP_PORT || 9333)
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/root/.nexus-browser/profile'
const DISPLAY = process.env.BROWSER_DISPLAY || ':99'
const VIEWPORT = { width: 1280, height: 800 }
// A page that never answers must not hang a chat turn — every CDP call is
// bounded, and navigation gets longer than the rest because a cold site plus
// a redirect chain legitimately takes a while.
const CALL_TIMEOUT_MS = 20_000
const NAV_TIMEOUT_MS = 45_000

// The sandbox's Chromium, newest build first. Overridable for a host that
// keeps its browser somewhere else.
export function findChrome(root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/usr/local/share/playwright') {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  let dirs = []
  try {
    dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-'))
  } catch {
    return null
  }
  // chromium-1243 sorts after chromium-1234 numerically, not lexically.
  dirs.sort((a, b) => Number(b.split('-')[1] || 0) - Number(a.split('-')[1] || 0))
  for (const d of dirs) {
    const exe = path.join(root, d, 'chrome-linux64', 'chrome')
    if (fs.existsSync(exe)) return exe
  }
  return null
}

export function chromeArgs({ port = CDP_PORT, profile = PROFILE_DIR } = {}) {
  return [
    `--remote-debugging-port=${port}`,
    // Bind the debugging port to loopback only. It is an unauthenticated
    // full-control interface over a browser holding the user's logins.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    // Nexus runs as root on this VPS and Chrome refuses its own sandbox as
    // root. The browser is reachable from loopback only and is itself the
    // thing being isolated, not the thing isolating.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,AutomationControlled',
    'about:blank',
  ]
}

let chrome = null
let xvfb = null
let socket = null
let nextId = 1
const pending = new Map()

async function cdpHttp(pathname) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`CDP ${pathname} -> HTTP ${r.status}`)
  return r.json()
}

async function chromeAlive() {
  try {
    await cdpHttp('/json/version')
    return true
  } catch {
    return false
  }
}

function startXvfb() {
  if (xvfb && xvfb.exitCode === null) return
  // -nolisten tcp: the display is for this machine's browser, nothing else.
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', `${VIEWPORT.width}x${VIEWPORT.height}x24`, '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: false,
  })
  xvfb.on('error', () => { xvfb = null })
}

async function launchChrome() {
  const exe = findChrome()
  if (!exe) throw new Error('No Chromium found on this host. Set CHROME_PATH to a Chrome/Chromium binary.')
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  startXvfb()
  chrome = spawn(exe, chromeArgs(), {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, DISPLAY },
  })
  chrome.on('exit', () => { chrome = null; socket = null })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await chromeAlive()) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Chromium did not open its debugging port within 30s')
}

// One websocket to one page target, reconnected on demand. Nexus drives a
// single tab on purpose: a user taking over has to see the page the agent is
// actually on, and a pile of background tabs makes that a guessing game.
async function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return socket
  let targets = await cdpHttp('/json/list')
  let page = targets.find((t) => t.type === 'page')
  if (!page) {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).catch(() => {})
    targets = await cdpHttp('/json/list')
    page = targets.find((t) => t.type === 'page')
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('Chromium has no page target to attach to')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket did not open')), 10_000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket failed')) }, { once: true })
  })
  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    const waiter = pending.get(msg.id)
    if (!waiter) return // an event, not a reply — nothing here subscribes yet
    pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP error'))
    else waiter.resolve(msg.result || {})
  })
  ws.addEventListener('close', () => { socket = null })
  socket = ws
  return ws
}

export async function send(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
  const ws = await connect()
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// Starts the browser if it isn't up, and returns the live page. Safe to call
// on every request — the common case is two cheap checks.
export async function ensureBrowser() {
  if (!(await chromeAlive())) await launchChrome()
  await connect()
  await send('Page.enable').catch(() => {})
  await send('Runtime.enable').catch(() => {})
  return state()
}

export async function state() {
  try {
    const { result } = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    })
    const parsed = JSON.parse(result?.value || '{}')
    return { running: true, url: parsed.url || 'about:blank', title: parsed.title || '' }
  } catch {
    return { running: false, url: null, title: '' }
  }
}

export async function goto(url) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new Error('Use a full http(s):// URL')
  await ensureBrowser()
  await send('Page.navigate', { url: target }, NAV_TIMEOUT_MS)
  await settle()
  return state()
}

// Waits for the page to stop being obviously busy. document.readyState is a
// weak signal on single-page apps, so this is a floor, not a guarantee —
// callers that need specific content should read and retry rather than trust
// this to mean "finished".
async function settle(maxMs = 8000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const { result } = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
      if (result?.value === 'complete') break
    } catch {
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  // A beat for client-side rendering that starts only after 'complete'.
  await new Promise((r) => setTimeout(r, 400))
}

export async function screenshotJpeg(quality = 60) {
  await ensureBrowser()
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false })
  return Buffer.from(data, 'base64')
}

// The page as text, for a model that cannot see. Capped because a long page
// otherwise eats the whole context window.
export async function readText(limit = 12000) {
  await ensureBrowser()
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG'])
      const walk = document.body ? document.body.innerText : ''
      return walk.replace(/\\n{3,}/g, '\\n\\n').trim()
    })()`,
    returnByValue: true,
  })
  const text = String(result?.value || '')
  return { text: text.slice(0, limit), truncated: text.length > limit }
}

// Visible links, so a text-only model can navigate without guessing URLs.
export async function links(limit = 40) {
  await ensureBrowser()
  const { result } = await send('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('a[href]')]
      .filter((a) => a.offsetParent !== null && a.innerText.trim())
      .slice(0, ${limit})
      .map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href })))`,
    returnByValue: true,
  })
  try {
    return JSON.parse(result?.value || '[]')
  } catch {
    return []
  }
}

export async function clickAt(x, y) {
  await ensureBrowser()
  const point = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
  return { ok: true }
}

// Click what the model can name, rather than pixel coordinates it has to
// guess from a screenshot. Returns what was actually clicked so a wrong match
// is visible in the transcript instead of silently doing nothing.
export async function clickText(needle) {
  await ensureBrowser()
  const target = JSON.stringify(String(needle || ''))
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const want = ${target}.trim().toLowerCase()
      if (!want) return JSON.stringify({ ok: false, reason: 'empty' })
      const candidates = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[role=link],summary,label')]
        .filter((el) => el.offsetParent !== null)
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase()
      const hit = candidates.find((el) => label(el) === want) || candidates.find((el) => label(el).includes(want))
      if (!hit) return JSON.stringify({ ok: false, reason: 'not found' })
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return JSON.stringify({ ok: true, clicked: label(hit).slice(0, 80), tag: hit.tagName })
    })()`,
    returnByValue: true,
  })
  const outcome = JSON.parse(result?.value || '{"ok":false}')
  if (outcome.ok) await settle(4000)
  return outcome
}

export async function typeText(text) {
  await ensureBrowser()
  // insertText goes into the focused field as one edit — far more reliable
  // than synthesising a keystroke per character, and it handles non-ASCII.
  await send('Input.insertText', { text: String(text ?? '') })
  return { ok: true }
}

// Fill a named field: the model says "Email", not a CSS selector it invented.
export async function fillField(label, value) {
  await ensureBrowser()
  const args = { label: String(label || ''), value: String(value ?? '') }
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const { label, value } = ${JSON.stringify(args)}
      const want = label.trim().toLowerCase()
      const fields = [...document.querySelectorAll('input,textarea')].filter((el) => el.offsetParent !== null)
      const name = (el) => [el.getAttribute('aria-label'), el.placeholder, el.name, el.id, el.type,
        (el.labels && el.labels[0] && el.labels[0].innerText) || ''].join(' ').toLowerCase()
      const hit = fields.find((el) => name(el).includes(want)) || (fields.length === 1 ? fields[0] : null)
      if (!hit) return JSON.stringify({ ok: false, reason: 'no matching field' })
      hit.focus()
      const setter = Object.getOwnPropertyDescriptor(hit.constructor.prototype, 'value')?.set
      setter ? setter.call(hit, value) : (hit.value = value)
      // React and friends listen for these, not for a raw value assignment.
      hit.dispatchEvent(new Event('input', { bubbles: true }))
      hit.dispatchEvent(new Event('change', { bubbles: true }))
      return JSON.stringify({ ok: true, field: name(hit).trim().slice(0, 60) })
    })()`,
    returnByValue: true,
  })
  return JSON.parse(result?.value || '{"ok":false}')
}

// Keys a page actually reacts to. Anything not listed is rejected rather than
// silently dispatched as a no-op keystroke.
export const KEYS = {
  Enter: { windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' },
  Tab: { windowsVirtualKeyCode: 9, key: 'Tab' },
  Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace' },
  Escape: { windowsVirtualKeyCode: 27, key: 'Escape' },
  ArrowUp: { windowsVirtualKeyCode: 38, key: 'ArrowUp' },
  ArrowDown: { windowsVirtualKeyCode: 40, key: 'ArrowDown' },
  ArrowLeft: { windowsVirtualKeyCode: 37, key: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, key: 'ArrowRight' },
  PageDown: { windowsVirtualKeyCode: 34, key: 'PageDown' },
  PageUp: { windowsVirtualKeyCode: 33, key: 'PageUp' },
}

export async function pressKey(name) {
  const spec = KEYS[name]
  if (!spec) throw new Error(`Unsupported key "${name}". Supported: ${Object.keys(KEYS).join(', ')}`)
  await ensureBrowser()
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec })
  if (spec.text) await send('Input.dispatchKeyEvent', { type: 'char', ...spec })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec })
  if (name === 'Enter') await settle(5000)
  return { ok: true }
}

export async function scrollBy(deltaY = 600) {
  await ensureBrowser()
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(VIEWPORT.width / 2),
    y: Math.round(VIEWPORT.height / 2),
    deltaX: 0,
    deltaY: Math.round(deltaY),
  })
  return { ok: true }
}

export async function stopBrowser() {
  try {
    socket?.close()
  } catch {}
  socket = null
  chrome?.kill()
  chrome = null
  xvfb?.kill()
  xvfb = null
  return { ok: true }
}

export const VIEWPORT_SIZE = VIEWPORT
