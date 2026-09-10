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

const getApiKey = () => process.env.RUNPOD_API_KEY || ''
let HOSTINGER_OLLAMA_URL = process.env.HOSTINGER_OLLAMA_URL || 'http://2.25.126.125:11434'
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

function setCurrentMode(mode) {
  currentMode = mode === 'turbo' ? 'turbo' : 'always_on'
  writeState({ mode: currentMode })
}

let currentMode = readState().mode === 'turbo' ? 'turbo' : 'always_on'
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
  return {
    mode: currentMode,
    hostingerUrl: HOSTINGER_OLLAMA_URL,
    runpodPodId: knownPodId,
    runpodActive: tunnel.ready,
    activeUrl: currentMode === 'turbo' ? 'http://127.0.0.1:11435' : HOSTINGER_OLLAMA_URL,
    details:
      currentMode === 'turbo'
        ? {
            label: 'Turbo: RunPod model (GPU)',
            speed: '30–65+ tok/s',
            cost: 'per hour while running',
            status: tunnel.ready ? 'ready' : 'disconnected',
          }
        : {
            label: 'Always On: Hostinger model (KVM 8)',
            speed: '2–5 tok/s',
            cost: '$26/mo flat',
            status: 'ready',
          },
  }
}

// Include the provider's real pod state so the UI can distinguish the selected
// route from a RunPod instance that is still running and accruing charges.
export async function getLiveComputeStatus() {
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
    const setup = getProvisioningState()
    return {
      ...getComputeStatus(),
      switching,
      runpodStatus: pod.status || 'UNKNOWN',
      runpodRunning: running,
      ...(setup ? { provisioning: setup } : {}),
      ...(setup?.message ? { notice: setup.message } : notice ? { notice } : {}),
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

export function getProvisioningState() {
  if (!provisioning) return null
  const { podId, startedAt, line, done, message } = provisioning
  return { podId, startedAt, line, done, message: message || null, minutes: Math.round((Date.now() - startedAt) / 60000) }
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
