import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

import { OllamaTunnel, podSshEndpoint, TURBO_URL } from './ollamaTunnel.js'

// Compute modes:
// 1. "always_on": Hostinger KVM 8 VPS (2-5 tok/s, 24/7 flat $26/mo)
// 2. "turbo": RunPod GPU pod (30-65+ tok/s, billed per hour while running)
// 3. "kaggle": a Kaggle notebook's 2x T4 GPU, reached over a reverse SSH
//    tunnel THE NOTEBOOK opens into this VPS (Kaggle has no public address —
//    the direction is inverted from Turbo, where the VPS opens the tunnel).
//    Not a service: it exists only while someone's notebook is running, capped
//    at ~12h/session and 30 GPU-hours/week by Kaggle. Measured on 2x T4:
//    reads ~390 tok/s, writes ~10-12 tok/s (see kaggle-nexus-benchmark.ipynb).

const getApiKey = () => process.env.RUNPOD_API_KEY || ''
let HOSTINGER_OLLAMA_URL = process.env.HOSTINGER_OLLAMA_URL || 'http://2.25.126.125:11434'
// Two Kaggle accounts, each with its OWN restricted tunnel key and its OWN
// port — a second notebook using the SAME key/port as the first cannot
// actually help (caught live, 2026-09-17): both tried to reverse-forward to
// 127.0.0.1:20140, so the second one's connection was refused outright
// ("bind [127.0.0.1]:20140: Address already in use") and just sat there
// doing nothing while the first was the only one actually serving chats.
// Each slot's authorized_keys entry restricts it to its own permitlisten
// port — these must stay in sync with the VPS or the notebook's
// reverse-forward is refused.
export const KAGGLE_SLOTS = [
  { id: 'a', label: 'Kaggle A', url: process.env.KAGGLE_URL || 'http://127.0.0.1:20140' },
  { id: 'b', label: 'Kaggle B', url: process.env.KAGGLE_URL_2 || 'http://127.0.0.1:20141' },
  { id: 'c', label: 'Kaggle C', url: process.env.KAGGLE_URL_3 || 'http://127.0.0.1:20142' },
]
// Kept for callers that only ever cared about "a" Kaggle URL (the primary
// slot) — the multi-slot logic lives behind isKaggleUrl()/findReachableKaggleSlot().
export const KAGGLE_URL = KAGGLE_SLOTS[0].url
export function isKaggleUrl(url) {
  return KAGGLE_SLOTS.some((s) => s.url === url)
}
function kaggleSlotById(id) {
  return KAGGLE_SLOTS.find((s) => s.id === id)
}
const KAGGLE_WEEKLY_LIMIT_S = 30 * 3600
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519')
// Overridable so a test can point at a temp file instead of racing other test
// files for the one real state file.
const STATE_FILE = process.env.NEXUS_COMPUTE_STATE || path.join(__dirname, '../.compute-state.json')

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch }
  // Per-process temp name: two processes writing state at once (the live
  // server plus a one-off `node -e` beside it, or parallel test runners) would
  // otherwise fight over one .tmp and rename each other's half-written file.
  const temporary = `${STATE_FILE}.tmp.${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify(next))
  try {
    fs.renameSync(temporary, STATE_FILE)
  } catch {
    // Windows refuses a rename onto a file another process still has open
    // (EPERM), which threw all the way out of a chat turn through
    // ensureKaggleReady. This file is advisory bookkeeping — usage counters
    // and the selected mode — so a rare in-place write is a far better outcome
    // than failing the request.
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(next))
    } catch {}
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
  return next
}

const MODES = new Set(['turbo', 'kaggle', 'always_on'])
function setCurrentMode(mode) {
  currentMode = MODES.has(mode) ? mode : 'always_on'
  writeState({ mode: currentMode })
}

let currentMode = MODES.has(readState().mode) ? readState().mode : 'always_on'

// Weekly Kaggle GPU-hour usage, PER ACCOUNT — each Kaggle account gets its own
// 30h/week from Kaggle, so a shared counter would have falsely shown account
// B as "almost out" just because A had been used heavily. Kaggle enforces the
// real cap on its own side; this is just so Nexus can warn before a mid-turn
// cutoff surprises someone. Accumulated only while a health check finds that
// account's tunnel actually up. Resets on a rolling 7 days from that
// account's first use, not calendar weeks (Kaggle's own reset time is not
// public).
// Kaggle's ~12h session cap, timed from the FIRST check that finds a given
// account's tunnel up after being down (a fresh notebook run, not a blip).
// Nexus has no way to ask Kaggle when the session actually started — this is
// an approximation that starts a little late, by however long that
// notebook's setup/build/download cells took before the tunnel came up.
// Cleared the moment that account's tunnel drops, so its next connection
// gets a fresh countdown, not a stale one.
export const KAGGLE_SESSION_LIMIT_S = 12 * 3600

function migrateKaggleAccounts() {
  const st = readState()
  // Pre-multi-account state used one flat usage/session pair — fold it into
  // slot 'a' rather than losing the quota history that account already used.
  // Slots MISSING from already-migrated state are backfilled too: state
  // written before a slot existed (the live VPS state had only a and b when
  // account C was added) otherwise left that slot undefined, and the first
  // health check that found C's tunnel up threw
  // "Cannot read properties of undefined (reading 'usage')" — swallowed by the
  // route's catch into a plain 500, so Kaggle just looked broken with nothing
  // in the logs. Adding a fourth account must never need a state migration.
  const accounts = { ...(st.kaggleAccounts || {}) }
  let added = false
  for (const slot of KAGGLE_SLOTS) {
    if (accounts[slot.id]) continue
    accounts[slot.id] = { usage: { windowStart: 0, seconds: 0 }, sessionStart: null }
    added = true
  }
  if (!st.kaggleAccounts) {
    if (st.kaggleUsage) accounts.a.usage = st.kaggleUsage
    if (st.kaggleSessionStart) accounts.a.sessionStart = st.kaggleSessionStart
  }
  if (added) writeState({ kaggleAccounts: accounts })
  return accounts
}
let kaggleAccounts = migrateKaggleAccounts()
const lastKaggleCheck = {} // slot id -> ms timestamp, for accrual math
// The slot Nexus is actually using right now — sticky across health checks
// so a healthy account isn't churned away from just because the OTHER one
// also happens to answer; only re-probed when the active one stops answering.
let kaggleActiveSlot = readState().kaggleActiveSlot || null
let lastKaggleReachableSlot = null

function persistKaggleAccounts() {
  writeState({ kaggleAccounts })
}

function trackKaggleUsage(slotId, connected) {
  const now = Date.now()
  const acct = kaggleAccounts[slotId]
  if (!acct.usage.windowStart || now - acct.usage.windowStart > 7 * 86400 * 1000) {
    acct.usage = { windowStart: now, seconds: 0 }
  }
  if (connected) {
    // "Is this a fresh session" is decided from sessionStart (persisted, and
    // only ever cleared on an OBSERVED disconnect below), never from
    // lastKaggleCheck — that one resets to 0 on every server restart, which
    // used to make a plain Nexus deploy (the tunnel never actually dropping)
    // look like a brand-new session and reset the 12h countdown to full.
    // A sessionStart older than Kaggle's own 12h cap cannot belong to a live
    // session — it is a leftover from a slot that dropped while ANOTHER slot
    // was active (only the active one gets cleared on a disconnect). Without
    // this, a fresh notebook on that account would show its countdown already
    // expired. A restart still keeps a genuinely-running session's start time.
    if (!acct.sessionStart || now - acct.sessionStart > KAGGLE_SESSION_LIMIT_S * 1000) acct.sessionStart = now
    if (lastKaggleCheck[slotId]) acct.usage.seconds += Math.min(300, (now - lastKaggleCheck[slotId]) / 1000)
  } else {
    acct.sessionStart = null
  }
  lastKaggleCheck[slotId] = connected ? now : 0
  persistKaggleAccounts()
}
// Swapping a slot onto a DIFFERENT Kaggle account resets that account's 30h —
// the cap is per account, and a fresh one starts at zero however much the old
// one burned. Nexus cannot detect the swap (a tunnel from a new account looks
// identical to the old one), so it has to be told.
export function resetKaggleUsage(slotId = null) {
  const ids = slotId ? [String(slotId)] : KAGGLE_SLOTS.map((s) => s.id)
  for (const id of ids) {
    if (!kaggleSlotById(id)) throw new Error(`Unknown Kaggle account "${id}".`)
    kaggleAccounts[id] = { usage: { windowStart: 0, seconds: 0 }, sessionStart: null }
    // Otherwise the next health check would credit the new account with the
    // seconds since the last check of the old one.
    lastKaggleCheck[id] = 0
  }
  persistKaggleAccounts()
  return ids
}
export function getKaggleUsage(slotId = kaggleActiveSlot || 'a') {
  const acct = kaggleAccounts[slotId] || kaggleAccounts.a
  const remaining = Math.max(0, KAGGLE_WEEKLY_LIMIT_S - acct.usage.seconds)
  return { usedSeconds: Math.round(acct.usage.seconds), remainingSeconds: Math.round(remaining), limitSeconds: KAGGLE_WEEKLY_LIMIT_S, windowStart: acct.usage.windowStart, slot: slotId }
}
// Client ticks this down locally from `startedAt` (see billing.js
// kaggleSessionCountdown) the same way the RunPod badge ticks down from
// pod.startedAt — one absolute timestamp, no server round-trip needed to move it.
export function getKaggleSessionTime(slotId = kaggleActiveSlot) {
  const acct = slotId && kaggleAccounts[slotId]
  if (!acct?.sessionStart) return null
  return { startedAt: acct.sessionStart, limitSeconds: KAGGLE_SESSION_LIMIT_S, approximate: true, slot: slotId }
}

// Is a given slot's reverse tunnel currently listening? A quick local check —
// no SSH involved, the tunnel already did that work — so this is cheap enough
// to run on every status poll.
// Probes /props rather than /health: it answers 200 exactly when /health would,
// and carries BOTH facts Nexus has to know about a run in the same request —
// default_generation_settings.n_ctx and modalities.vision (shape verified
// against a live llama-server, 2026-09-17).
//
// Neither may be assumed. The notebook picks --ctx-size off a fallback ladder,
// so the window differs per run; hardcoding it is what caused "request (37742
// tokens) exceeds the available context size (32768 tokens)" in production.
// And vision depends on whether that run found an mmproj to load, so sending
// images to a server without one would fail the request outright.
const kaggleProps = {} // slot id -> { ctx, vision }
async function kaggleSlotReachable(slot) {
  try {
    const r = await fetch(`${slot.url}/props`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return false
    const j = await r.json()
    const n = j?.default_generation_settings?.n_ctx
    kaggleProps[slot.id] = {
      ctx: Number.isFinite(n) && n > 0 ? n : undefined,
      vision: Boolean(j?.modalities?.vision),
    }
    return true
  } catch {
    return false
  }
}
// The active account's real context window, or null when it has not been seen.
// Callers must fall back to a safe floor rather than assuming a size.
export function getKaggleCtx() {
  return kaggleProps[kaggleActiveSlot]?.ctx || null
}
// Whether the active account's run actually loaded a vision projector. Defaults
// to false, so an unknown server is treated as text-only rather than being sent
// images it cannot decode.
export function getKaggleVision() {
  return Boolean(kaggleProps[kaggleActiveSlot]?.vision)
}
// Back-compat: reachability of the primary slot only, for callers that don't
// need to know about multiple accounts.
export async function kaggleReachable() {
  return kaggleSlotReachable(KAGGLE_SLOTS[0])
}
// Tries the currently-active slot first (sticky — a slow-to-answer health
// check on the account already in use shouldn't bounce Nexus onto the other
// one), then the rest in order. Returns the slot that answered, or null if
// NEITHER Kaggle account currently has a tunnel up.
async function findReachableKaggleSlot() {
  const ordered = kaggleActiveSlot
    ? [kaggleSlotById(kaggleActiveSlot), ...KAGGLE_SLOTS.filter((s) => s.id !== kaggleActiveSlot)]
    : KAGGLE_SLOTS
  for (const slot of ordered) {
    if (slot && (await kaggleSlotReachable(slot))) return slot
  }
  return null
}
function activeKaggleSlot() {
  return kaggleSlotById(kaggleActiveSlot) || KAGGLE_SLOTS[0]
}

// The cron watchdog (/root/.kaggle-accounts) restarts dead accounts over the
// Kaggle API and already knows WHY a slot has no tunnel — it just kept that to
// its own log, so the bar said "start a notebook and run its tunnel cell" while
// a notebook was in fact booting, or while Kaggle was refusing every push
// because the weekly cap was spent. Read its stamps and log instead of guessing.
const WATCHDOG_DIR = process.env.KAGGLE_WATCHDOG_DIR || '/root/.kaggle-accounts'
// A cold start (CUDA build + the model download) measured ~25-30 min; past that
// a run that still has not opened its tunnel is not "booting", it is stuck.
const KAGGLE_BOOT_S = 35 * 60

function kaggleSlotReason(slotId) {
  // The watchdog stamps a restart whether the push SUCCEEDED or was refused,
  // so a stamp alone cannot mean "starting" — a slot Kaggle rejected on quota
  // would claim to be booting forever. The log line it writes straight after
  // the stamp settles it, but only when it is NEWER than the stamp: an older
  // failure belongs to a previous attempt that has since been superseded
  // (account A's key swap pushed by hand, with no log line of its own).
  let stamp = 0
  try {
    stamp = Number(fs.readFileSync(path.join(WATCHDOG_DIR, `.last_restart_${slotId}`), 'utf8').trim()) || 0
  } catch {}

  let failure = null
  let failureAt = 0
  try {
    const lines = fs.readFileSync(path.join(WATCHDOG_DIR, 'watchdog.log'), 'utf8').trimEnd().split(/\r?\n/)
    const last = lines.reverse().find((l) => l.includes(` ${slotId}: `))
    if (last) {
      const said = last.slice(last.indexOf(` ${slotId}: `) + slotId.length + 3).trim()
      const at = Date.parse(last.slice(0, last.indexOf(' ')))
      if (/quota/i.test(said)) failure = "Kaggle's weekly GPU quota is used up"
      else if (/error/i.test(said)) failure = said
      if (failure) failureAt = Number.isFinite(at) ? Math.floor(at / 1000) : 0
    }
  } catch {}

  if (failure && failureAt >= stamp) return failure
  const age = (Date.now() - stamp * 1000) / 1000
  if (stamp && age >= 0 && age < KAGGLE_BOOT_S) return `starting (${Math.round(age / 60)}m in, takes ~25-30m)`
  return failure
}

// One line naming every account's real state, or null when the watchdog is not
// on this machine (a dev box) and there is nothing better to say than the
// generic message.
function kaggleDownReason() {
  const parts = KAGGLE_SLOTS.map((s) => {
    const reason = kaggleSlotReason(s.id)
    return reason ? `${s.label}: ${reason}` : null
  }).filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

export function switchToKaggle() {
  setCurrentMode('kaggle')
  return getComputeStatus()
}

// Called by a chat turn before sending to Kaggle, mirroring ensureTurboReady:
// checks both accounts and uses whichever answers; falls back to Always On
// only when NEITHER notebook's tunnel is up, instead of hanging the turn on
// a target that will never answer.
export async function ensureKaggleReady() {
  if (currentMode !== 'kaggle') return false
  const slot = await findReachableKaggleSlot()
  if (slot) {
    lastKaggleReachableSlot = slot.id
    kaggleActiveSlot = slot.id
    writeState({ kaggleActiveSlot })
    trackKaggleUsage(slot.id, true)
    return true
  }
  if (kaggleActiveSlot) trackKaggleUsage(kaggleActiveSlot, false)
  lastKaggleReachableSlot = null
  setCurrentMode('always_on')
  lastFallbackReason = 'no Kaggle notebook is connected on either account (start one and open its tunnel cell)'
  return false
}
// A pod id is not a permanent address. Pods get exited when funds run out, GPUs
// get reclaimed, and the replacement has a NEW id — so a single id baked into
// .env means every replacement needs someone to edit the server by hand. The
// id below is only a starting hint; resolvePodId() falls back to asking the
// RunPod account what pods actually exist.
let knownPodId = readState().podId || (process.env.RUNPOD_POD_ID || '').trim() || null

export function setPodId(id) {
  const clean = String(id || '').trim()
  if (!/^[a-z0-9]{6,32}$/i.test(clean)) throw new Error('That does not look like a RunPod pod id.')
  knownPodId = clean
  writeState({ podId: clean })
  return clean
}
const tunnel = new OllamaTunnel(SSH_KEY_PATH)
let switchPromise = null

function exclusiveSwitch(operation) {
  if (switchPromise) throw new Error('A compute switch is already in progress. Please wait.')
  switchPromise = Promise.resolve().then(operation).finally(() => { switchPromise = null })
  return switchPromise
}

// Robust RunPod REST v2 API caller using node:https to avoid Node 24 undici TLS issues
export function runpodRequest(apiPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath.startsWith('http') ? apiPath : `https://api.runpod.io/v2${apiPath}`)
    const payload = body ? JSON.stringify(body) : null
    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          'User-Agent': 'curl/8.4.0',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`Runpod API ${res.statusCode}: ${data}`))
          }
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(data)
          }
        })
      }
    )
    req.setTimeout(20000, () => req.destroy(new Error('RunPod API timed out')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export function getComputeStatus() {
  const activeUrl = currentMode === 'turbo' ? 'http://127.0.0.1:11435' : currentMode === 'kaggle' ? activeKaggleSlot().url : HOSTINGER_OLLAMA_URL
  let details
  if (currentMode === 'turbo') {
    details = { label: 'Turbo: RunPod model (GPU)', speed: '30–65+ tok/s', cost: 'per hour while running', status: tunnel.ready ? 'ready' : 'disconnected' }
  } else if (currentMode === 'kaggle') {
    const slot = activeKaggleSlot()
    details = {
      label: `Kaggle: notebook GPU (2x T4) — ${slot.label}`,
      speed: '~10-12 tok/s, reads ~390 tok/s',
      cost: 'free — 30 GPU-hrs/week per account',
      status: lastKaggleReachableSlot ? 'ready' : 'disconnected',
      usage: getKaggleUsage(slot.id),
      session: getKaggleSessionTime(slot.id),
      // Both accounts' quota, so the UI can show which one to switch to
      // before this one runs out, instead of only the one in use right now.
      accounts: KAGGLE_SLOTS.map((s) => ({ id: s.id, label: s.label, connected: lastKaggleReachableSlot === s.id, usage: getKaggleUsage(s.id) })),
    }
  } else {
    details = { label: 'Always On: Hostinger model (KVM 8)', speed: '2–5 tok/s', cost: '$26/mo flat', status: 'ready' }
  }
  return { mode: currentMode, hostingerUrl: HOSTINGER_OLLAMA_URL, runpodPodId: knownPodId, runpodActive: tunnel.ready, activeUrl, details }
}

// Include the provider's real pod state so the UI can distinguish the selected
// route from a RunPod instance that is still running and accruing charges.
export async function getLiveComputeStatus() {
  // Kaggle has no RunPod pod to poll and no provisioning state — a short,
  // separate path instead of threading a third mode through the RunPod logic
  // below (which fetches pod details unconditionally, for the pod picker).
  if (currentMode === 'kaggle') {
    const slot = await findReachableKaggleSlot()
    if (slot) {
      lastKaggleReachableSlot = slot.id
      kaggleActiveSlot = slot.id
      writeState({ kaggleActiveSlot })
      trackKaggleUsage(slot.id, true)
    } else {
      if (kaggleActiveSlot) trackKaggleUsage(kaggleActiveSlot, false)
      lastKaggleReachableSlot = null
    }
    const usage = getKaggleUsage(activeKaggleSlot().id)
    let notice = null
    if (!slot) {
      const why = kaggleDownReason()
      notice = why
        ? `No Kaggle tunnel yet — ${why}.`
        : 'No Kaggle notebook is connected on either account. Start one and run its tunnel cell — Nexus will pick it up automatically.'
    }
    else if (usage.remainingSeconds < 3600) notice = `${activeKaggleSlot().label}'s weekly GPU quota is nearly used up (~${Math.round(usage.remainingSeconds / 60)} min left). Switch to the other account, or it may cut off mid-turn.`
    return { ...getComputeStatus(), switching: Boolean(switchPromise), ...(notice ? { notice } : {}) }
  }
  await tunnel.health()
  const switching = Boolean(switchPromise)
  try {
    const pod = await fetchPodDetails()
    const running = pod.status === 'RUNNING'
    // Turbo selected but the pod isn't running (RunPod exits pods when the
    // balance hits zero). Saying "Connected — Turbo" then is simply false, and
    // it strands every message on a tunnel that cannot come back. Fall back to
    // Always On and say why, instead of "Reconnecting…" forever.
    let notice = null
    if (currentMode === 'turbo' && !running && !switching) {
      await tunnel.stop()
      setCurrentMode('always_on')
      notice = `The RunPod pod is ${String(pod.status || 'not running').toLowerCase()}, so Turbo can't be used. Switched to Always On. Click Turbo to start the pod again.`
    }
    // Prepare a freshly created pod without being asked. Deliberately not
    // awaited: an SSH probe must not slow down a status poll — the next poll,
    // seconds later, reports the progress.
    if (running && !notice) autoProvisionIfNeeded(podIdOf(pod), pod).catch(() => {})
    // Turbo selected, pod up, but no tunnel — a restarted server or an SSH
    // connection that dropped. Nothing used to rebuild it, so Turbo stayed
    // selected and every message failed with "can't reach the tunnel".
    // A finished provisioning (done, incl. a stale failure) must NOT block the
    // reconnect — otherwise a past failure strands Turbo forever even after the
    // model is fixed. Only an actively-running provisioning should hold it off.
    if (currentMode === 'turbo' && running && !tunnel.ready && !switching && !(provisioning && !provisioning.done)) {
      reconnectTunnelIfNeeded(podIdOf(pod))
    }

    // Don't show a failed-setup banner once the model is actually installed.
    const setup = getProvisioningState()
    const showSetup = setup && !(setup.done && setup.failed)
    return {
      ...getComputeStatus(),
      switching,
      runpodStatus: pod.status || 'UNKNOWN',
      runpodRunning: running,
      ...(showSetup ? { provisioning: setup } : {}),
      ...(showSetup?.message ? { notice: showSetup.message } : notice ? { notice } : {}),
    }
  } catch (err) {
    // Can't reach RunPod at all — don't claim Turbo is live.
    let notice = null
    if (currentMode === 'turbo' && !switching && !tunnel.ready) {
      setCurrentMode('always_on')
      notice = `Couldn't reach RunPod (${err.message}). Switched to Always On.`
    }
    return {
      ...getComputeStatus(),
      switching,
      runpodStatus: 'UNKNOWN',
      runpodRunning: false,
      runpodStatusError: err.message,
      ...(notice ? { notice } : {}),
    }
  }
}

export function setHostingerIp(ipOrUrl) {
  if (!ipOrUrl) return
  const clean = ipOrUrl.trim()
  HOSTINGER_OLLAMA_URL = clean.startsWith('http') ? clean : `http://${clean}:11434`
  return HOSTINGER_OLLAMA_URL
}

// Every pod on the account. This is what makes a replacement pod just work:
// the id is discovered, not configured.
export async function listPods() {
  const data = await runpodRequest('https://rest.runpod.io/v1/pods')
  return Array.isArray(data) ? data : []
}

// The pod to use: the known one if it still exists, otherwise whatever the
// account actually has — preferring a running pod, else the newest.
export async function resolvePodId() {
  if (knownPodId) {
    try {
      await runpodRequest(`/pods/${knownPodId}`)
      return knownPodId
    } catch {
      // Terminated or belongs to a different account — fall through and look.
    }
  }
  const pods = await listPods()
  if (!pods.length) {
    throw new Error('No pods found on this RunPod account. Create a pod in RunPod, then click Turbo again.')
  }
  const pick =
    pods.find((p) => p.desiredStatus === 'RUNNING') ||
    [...pods].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
  setPodId(pick.id)
  return pick.id
}

// Account balance + spend rate from RunPod's GraphQL API (the REST API has
// no balance endpoint), plus the current pod's cost and uptime, so the app
// can show what Turbo is costing without a trip to runpod.io.
export function runpodGraphql(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query })
    const req = https.request('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'curl/8.4.0' },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`RunPod GraphQL ${res.statusCode}: ${data.slice(0, 200)}`))
        try {
          const j = JSON.parse(data)
          if (j.errors?.length) return reject(new Error(j.errors[0].message))
          resolve(j.data)
        } catch (e) { reject(e) }
      })
    })
    req.setTimeout(20000, () => req.destroy(new Error('RunPod API timed out')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export async function getRunpodBilling() {
  const data = await runpodGraphql('{ myself { clientBalance currentSpendPerHr spendLimit } }')
  const me = data?.myself || {}
  let pod = null
  try {
    const p = await fetchPodDetails()
    pod = { id: p.id, name: p.name, status: p.status || p.desiredStatus, costPerHr: Number(p.cost) || 0, uptimeSeconds: Number(p.runtime?.uptime) || 0, startedAt: p.startedAt || null, gpu: p.gpu?.id || null }
  } catch {
    pod = null // no pod is not an error for the balance panel
  }
  // Measured on 2026-09-13 by watching the balance: it sits still and then
  // drops by exactly five minutes of spend, at uptime 41:21 and 46:17 — so
  // RunPod deducts in 5-minute chunks from the pod's start (landing a
  // minute or so after each boundary). Override if RunPod changes it; the
  // client counts down to the next chunk from this.
  const cycleSeconds = Number(process.env.RUNPOD_BILLING_CYCLE_SECONDS) || 300
  return { balance: Number(me.clientBalance) || 0, spendPerHr: Number(me.currentSpendPerHr) || 0, spendLimit: me.spendLimit ?? null, pod, cycleSeconds, fetchedAt: Date.now() }
}

// Fetch live pod status from Runpod REST v2 API
export async function fetchPodDetails(podId) {
  return runpodRequest(`/pods/${podId || (await resolvePodId())}`)
}

// Start Runpod Pod
export async function startRunpodPod(podId) {
  const id = podId || (await resolvePodId())
  return runpodRequest(`/pods/${id}/action`, {
    method: 'POST',
    body: { action: 'start' },
  })
}

// Stop the pod only after the provider confirms the action.
async function stopPod(podId) {
  podId = podId || (await resolvePodId())
  const result = await runpodRequest(`/pods/${podId}/action`, {
    method: 'POST', body: { action: 'stop' },
  })
  await tunnel.stop()
  setCurrentMode('always_on')
  return result
}

export function stopRunpodPod(podId) {
  return exclusiveSwitch(() => stopPod(podId))
}

// Terminate: destroys the pod AND its /workspace volume (Ollama + the model).
// Irreversible, so the caller must name the pod explicitly — never a resolved
// default, which would make "terminate" hit whatever pod happened to be found.
export function terminateRunpodPod(podId) {
  const id = String(podId || '').trim()
  if (!id) throw new Error('A pod id is required to terminate a pod.')
  return exclusiveSwitch(async () => {
    let result
    try {
      result = await runpodRequest(`/pods/${id}/action`, { method: 'POST', body: { action: 'terminate' } })
    } catch {
      result = await runpodRequest(`https://rest.runpod.io/v1/pods/${id}`, { method: 'DELETE' })
    }
    // Forget it, so the next Turbo press discovers the replacement pod instead
    // of retrying a pod that no longer exists.
    if (knownPodId === id) {
      knownPodId = null
      writeState({ podId: null })
      await tunnel.stop()
      setCurrentMode('always_on')
    }
    if (provisioning?.podId === id) {
      if (provisioning.timer) clearInterval(provisioning.timer)
      provisioning = null
    }
    return result
  })
}

export async function startTunnel(host, port) {
  return tunnel.start(host, port)
}

export async function killTunnel() {
  return tunnel.stop()
}

// A fresh pod has to download ~17GB before Turbo can work. Nobody should have
// to sit pressing a button to find out how it's going, so the server watches
// the install itself, reports the installer's own progress line, and connects
// Turbo the moment the model is there.
let provisioning = null

function watchProvisioning(podId, host, port, firstMessage) {
  if (provisioning?.timer) clearInterval(provisioning.timer)
  provisioning = { podId, host, port, startedAt: Date.now(), line: firstMessage, done: false, timer: null }

  const finish = (patch) => {
    clearInterval(provisioning.timer)
    provisioning = { ...provisioning, ...patch, timer: null }
  }

  const tick = async () => {
    // Don't let a forgotten pod poll forever.
    if (Date.now() - provisioning.startedAt > 90 * 60_000) {
      return finish({ done: true, message: 'Pod setup has been running for over an hour — check the pod in RunPod.' })
    }
    const p = await tunnel.provisionProgress(host, port)
    if (p.line) provisioning.line = p.line
    // The installer stopped without finishing — say so, with its last output,
    // rather than counting minutes at a process that is already dead.
    if (p.failed) {
      // The installer's log can end on a transient error even though the model
      // finished (e.g. a network-volume close error that ollama then re-pulled).
      // Believe the actual state: if the model is present, this is a success.
      if (await tunnel.podHasModel(host, port)) {
        finish({ done: true })
        try { await switchToTurbo({ podId }); provisioning.message = 'Your model is installed — Turbo is live.' }
        catch (err) { provisioning.message = `The model is installed, but Turbo could not connect: ${err.message}` }
        return
      }
      return finish({ done: true, failed: true, message: `Pod setup failed: ${p.line || 'the installer stopped'}. Press Turbo to try again.` })
    }
    if (!p.done) return
    finish({ done: true })
    try {
      await switchToTurbo({ podId })
      provisioning.message = 'Your model finished installing — Turbo is live.'
    } catch (err) {
      provisioning.message = `The model finished downloading, but Turbo could not connect: ${err.message}`
    }
  }

  provisioning.timer = setInterval(tick, 30000)
  provisioning.timer.unref?.()
  tick()
}

// A pod the user just created is not useful until Ollama and the model are on
// it, and making that wait for a button press means the app sits there saying
// "pod is running" while doing nothing — which is exactly what it looked like.
// When a running pod has no model, start the install in the background.
const podIdOf = (pod) => pod?.id || knownPodId
const autoTried = new Map() // podId -> last attempt, so a failing pod is not hammered

let lastReconnect = 0
function reconnectTunnelIfNeeded(podId) {
  if (Date.now() - lastReconnect < 60_000) return
  lastReconnect = Date.now()
  switchToTurbo({ podId }).catch((err) => {
    console.error('[nexus-ai] Turbo tunnel could not be rebuilt:', err.message)
  })
}

async function autoProvisionIfNeeded(podId, pod) {
  // A finished provisioning (done/failed) must not block this — otherwise a
  // stale failure is never cleared even after the model is installed.
  if ((provisioning && !provisioning.done) || switchPromise || tunnel.ready) return
  const last = autoTried.get(podId) || 0
  if (Date.now() - last < 5 * 60_000) return
  autoTried.set(podId, Date.now())

  const endpoint = podSshEndpoint(pod)
  if (!endpoint) return
  // Model is already there (e.g. a transient download error self-healed, or it
  // was fixed by hand): clear any stale provisioning banner and stop.
  if (await tunnel.podHasModel(endpoint.host, endpoint.port)) { provisioning = null; return }

  const message = await tunnel.provision(endpoint.host, tunnel.sshCommon(endpoint.port))
  watchProvisioning(podId, endpoint.host, endpoint.port, message)
}

// Called before a Turbo request actually uses the tunnel. An SSH tunnel can
// go ZOMBIE: the local listener still accepts connections, so the port looks
// open, but nothing flows to the pod — the request then hangs until undici
// gives up with UND_ERR_HEADERS_TIMEOUT, minutes later. A 2-second probe
// catches that and rebuilds the tunnel before the user waits at all.
// Called by a chat turn before (and during) a Turbo request. The dashboard's
// status poll is what used to notice a dead pod and fall back to Always On, but
// a chat job doesn't poll: with the dashboard closed, a pod exited for lack of
// credit left every turn aimed at a tunnel that could never come back, and
// this tried to START the pod — which fails with no balance. Reconnect only to
// a pod that is actually RUNNING; otherwise fall back to Always On so the turn
// still runs. Returns true only when Turbo is usable.
export async function ensureTurboReady() {
  if (currentMode !== 'turbo') return false
  if (await tunnel.health()) return true
  if (switchPromise) {
    // A switch someone started is under way — let it finish rather than race it.
    try { await switchPromise } catch {}
    if (currentMode === 'turbo' && (await tunnel.health())) return true
    if (currentMode !== 'turbo') return false
  }
  let reason
  try {
    const pod = await fetchPodDetails()
    if (pod.status === 'RUNNING') {
      await switchToTurbo({ podId: podIdOf(pod) })
      if (tunnel.ready) return true
      reason = 'the GPU tunnel did not come back'
    } else {
      reason = `the RunPod pod is ${String(pod.status || 'not running').toLowerCase()}`
    }
  } catch (err) {
    reason = `RunPod could not be reached (${err.message})`
  }
  await tunnel.stop().catch(() => {})
  setCurrentMode('always_on')
  lastFallbackReason = reason
  return false
}

let lastFallbackReason = null
// The reason for the most recent automatic Turbo -> Always On fallback, once.
export function takeFallbackReason() {
  const r = lastFallbackReason
  lastFallbackReason = null
  return r
}

export function getProvisioningState() {
  if (!provisioning) return null
  const { podId, startedAt, line, done, failed, message } = provisioning
  return { podId, startedAt, line, done, failed: !!failed, message: message || null, minutes: Math.round((Date.now() - startedAt) / 60000) }
}

export function switchToTurbo({ podId } = {}) {
  return exclusiveSwitch(async () => {
    podId = podId || (await resolvePodId())
    let pod = await fetchPodDetails(podId)
    if (pod.status !== 'RUNNING') await startRunpodPod(podId)
    const start = Date.now()
    let endpoint = podSshEndpoint(pod)
    while (!endpoint && Date.now() - start < 120000) {
      await new Promise(resolve => setTimeout(resolve, 3000))
      pod = await fetchPodDetails(podId)
      endpoint = podSshEndpoint(pod)
    }
    if (!endpoint) throw new Error('RunPod has not published a ready SSH endpoint yet. Please retry shortly.')
    try {
      await tunnel.start(endpoint.host, endpoint.port)
    } catch (err) {
      // A pod that hasn't been set up yet isn't a failure — it's a new pod.
      // Hand back a "setting up" state and keep watching it in the background,
      // rather than a red error the user has to keep re-triggering.
      if (err.provisioning) {
        watchProvisioning(podId, endpoint.host, endpoint.port, err.message)
        return { mode: currentMode, podId, provisioning: true, message: err.message }
      }
      throw err
    }
    setCurrentMode('turbo')
    return { mode: 'turbo', podId, tunnelOk: true, url: TURBO_URL,
      message: 'Connected to RunPod GPU' }
  })
}

export function switchToAlwaysOn({ stopPod: shouldStopPod = false } = {}) {
  return exclusiveSwitch(async () => {
    // Route to Hostinger even if the provider refuses to stop the GPU, but
    // report the stop error so the UI never claims its billing has stopped.
    await tunnel.stop()
    setCurrentMode('always_on')
    if (shouldStopPod) await stopPod()
    return { mode: 'always_on', url: HOSTINGER_OLLAMA_URL,
      message: 'Connected to Hostinger model' }
  })
}

// PM2 restarts must not silently change which provider the user selected.
// Rebuild the RunPod tunnel when Turbo was the persisted mode.
export async function restoreComputeMode() {
  if (currentMode !== 'turbo') return getComputeStatus()
  try {
    await switchToTurbo()
  } catch (err) {
    console.error('[nexus-ai] Could not restore Turbo mode:', err.message)
    setCurrentMode('always_on')
  }
  return getComputeStatus()
}
