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
// The tunnel's authorized_keys entry restricts it to `permitlisten="127.0.0.1:20140"` —
// this must stay the same port or the notebook's reverse-forward is refused.
export const KAGGLE_URL = process.env.KAGGLE_URL || 'http://127.0.0.1:20140'
const KAGGLE_WEEKLY_LIMIT_S = 30 * 3600
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519')
const STATE_FILE = path.join(__dirname, '../.compute-state.json')

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch }
  const temporary = `${STATE_FILE}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(next))
  fs.renameSync(temporary, STATE_FILE)
  return next
}

const MODES = new Set(['turbo', 'kaggle', 'always_on'])
function setCurrentMode(mode) {
  currentMode = MODES.has(mode) ? mode : 'always_on'
  writeState({ mode: currentMode })
}

let currentMode = MODES.has(readState().mode) ? readState().mode : 'always_on'

// Weekly Kaggle GPU-hour usage. Kaggle enforces the real 30h/week cap on its
// own side; this is just so Nexus can warn before a mid-turn cutoff surprises
// someone. Accumulated only while a health check finds the tunnel actually up,
// so a closed notebook does not keep racking up hours. Resets on a rolling 7
// days from first use, not calendar weeks (Kaggle's own reset time is not public).
let kaggleUsage = readState().kaggleUsage || { windowStart: 0, seconds: 0 }
let lastKaggleCheck = 0
// Kaggle's ~12h session cap, timed from the FIRST check that finds the tunnel
// up after being down (a fresh notebook run, not a blip). Nexus has no way to
// ask Kaggle when the session actually started — this is an approximation
// that starts a little late, by however long the notebook's setup/build/
// download cells took before the tunnel came up. Cleared the moment the
// tunnel drops, so the next connection gets a fresh countdown, not a stale one.
export const KAGGLE_SESSION_LIMIT_S = 12 * 3600
let kaggleSessionStart = readState().kaggleSessionStart || null
function trackKaggleUsage(connected) {
  const now = Date.now()
  if (!kaggleUsage.windowStart || now - kaggleUsage.windowStart > 7 * 86400 * 1000) {
    kaggleUsage = { windowStart: now, seconds: 0 }
  }
  if (connected) {
    if (!lastKaggleCheck) kaggleSessionStart = now // just (re)connected
    else kaggleUsage.seconds += Math.min(300, (now - lastKaggleCheck) / 1000)
  } else {
    kaggleSessionStart = null
  }
  lastKaggleCheck = connected ? now : 0
  writeState({ kaggleUsage, kaggleSessionStart })
}
export function getKaggleUsage() {
  const remaining = Math.max(0, KAGGLE_WEEKLY_LIMIT_S - kaggleUsage.seconds)
  return { usedSeconds: Math.round(kaggleUsage.seconds), remainingSeconds: Math.round(remaining), limitSeconds: KAGGLE_WEEKLY_LIMIT_S, windowStart: kaggleUsage.windowStart }
}
// Client ticks this down locally from `startedAt` (see billing.js
// kaggleSessionCountdown) the same way the RunPod badge ticks down from
// pod.startedAt — one absolute timestamp, no server round-trip needed to move it.
export function getKaggleSessionTime() {
  if (!kaggleSessionStart) return null
  return { startedAt: kaggleSessionStart, limitSeconds: KAGGLE_SESSION_LIMIT_S, approximate: true }
}

// Is the notebook's reverse tunnel currently listening? A quick local check —
// no SSH involved, the tunnel already did that work — so this is cheap enough
// to run on every status poll.
export async function kaggleReachable() {
  try {
    const r = await fetch(`${KAGGLE_URL}/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch {
    return false
  }
}
let lastKaggleReachable = false

export function switchToKaggle() {
  setCurrentMode('kaggle')
  return getComputeStatus()
}

// Called by a chat turn before sending to Kaggle, mirroring ensureTurboReady:
// if the notebook's tunnel is not up, fall back to Always On instead of
// hanging the turn on a target that will never answer.
export async function ensureKaggleReady() {
  if (currentMode !== 'kaggle') return false
  const ok = await kaggleReachable()
  lastKaggleReachable = ok
  trackKaggleUsage(ok)
  if (ok) return true
  setCurrentMode('always_on')
  lastFallbackReason = 'the Kaggle notebook is not connected (start it and open the tunnel cell)'
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
  const activeUrl = currentMode === 'turbo' ? 'http://127.0.0.1:11435' : currentMode === 'kaggle' ? KAGGLE_URL : HOSTINGER_OLLAMA_URL
  let details
  if (currentMode === 'turbo') {
    details = { label: 'Turbo: RunPod model (GPU)', speed: '30–65+ tok/s', cost: 'per hour while running', status: tunnel.ready ? 'ready' : 'disconnected' }
  } else if (currentMode === 'kaggle') {
    details = { label: 'Kaggle: notebook GPU (2x T4)', speed: '~10-12 tok/s, reads ~390 tok/s', cost: 'free — 30 GPU-hrs/week', status: lastKaggleReachable ? 'ready' : 'disconnected', usage: getKaggleUsage(), session: getKaggleSessionTime() }
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
    const ok = await kaggleReachable()
    lastKaggleReachable = ok
    trackKaggleUsage(ok)
    const usage = getKaggleUsage()
    let notice = null
    if (!ok) notice = 'The Kaggle notebook is not connected. Start it and run the tunnel cell — Nexus will pick it up automatically.'
    else if (usage.remainingSeconds < 3600) notice = `Kaggle's weekly GPU quota is nearly used up (~${Math.round(usage.remainingSeconds / 60)} min left). It may cut off mid-turn.`
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
