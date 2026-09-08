import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// Compute modes:
// 1. "always_on": Hostinger KVM 8 VPS (2-5 tok/s, 24/7 flat $26/mo)
// 2. "turbo": Runpod RTX 3090 GPU (30-65 tok/s, on-demand $0.50/hr)

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || ''
let RUNPOD_POD_ID = process.env.RUNPOD_POD_ID || 'naomdzahw3yqeu'
let HOSTINGER_OLLAMA_URL = process.env.HOSTINGER_OLLAMA_URL || 'http://127.0.0.1:11434'
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519')

let currentMode = 'always_on' // 'always_on' | 'turbo'
let tunnelProcess = null
let currentPodInfo = null

export function getComputeStatus() {
  return {
    mode: currentMode,
    hostingerUrl: HOSTINGER_OLLAMA_URL,
    runpodPodId: RUNPOD_POD_ID,
    runpodActive: Boolean(tunnelProcess),
    activeUrl: currentMode === 'turbo' ? 'http://127.0.0.1:11435' : HOSTINGER_OLLAMA_URL,
    details: currentMode === 'turbo'
      ? { label: 'Turbo (Runpod RTX 3090)', speed: '30–65 tok/s', cost: '$0.50/hr', status: tunnelProcess ? 'ready' : 'connecting' }
      : { label: 'Always On (KVM 8)', speed: '2–5 tok/s', cost: '$26/mo flat', status: 'ready' },
  }
}

export function setHostingerIp(ipOrUrl) {
  if (!ipOrUrl) return
  const clean = ipOrUrl.trim()
  HOSTINGER_OLLAMA_URL = clean.startsWith('http') ? clean : `http://${clean}:11434`
  return HOSTINGER_OLLAMA_URL
}

// Fetch live pod status from Runpod REST v2 API
export async function fetchPodDetails(podId = RUNPOD_POD_ID) {
  const resp = await fetch(`https://api.runpod.io/v2/pods/${podId}`, {
    headers: { Authorization: `Bearer ${RUNPOD_API_KEY}` },
  })
  if (!resp.ok) {
    throw new Error(`Runpod API error: ${resp.status} ${resp.statusText}`)
  }
  const data = await resp.json()
  currentPodInfo = data
  return data
}

// Start Runpod Pod
export async function startRunpodPod(podId = RUNPOD_POD_ID) {
  const resp = await fetch(`https://api.runpod.io/v2/pods/${podId}/action`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'start' }),
  })
  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`Failed to start pod: ${resp.status} ${txt}`)
  }
  return resp.json().catch(() => ({}))
}

// Stop Runpod Pod (halts hourly billing)
export async function stopRunpodPod(podId = RUNPOD_POD_ID) {
  // Kill active SSH tunnel if running
  killTunnel()

  const resp = await fetch(`https://api.runpod.io/v2/pods/${podId}/action`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'stop' }),
  })
  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`Failed to stop pod: ${resp.status} ${txt}`)
  }
  currentMode = 'always_on'
  return resp.json().catch(() => ({}))
}

// Start SSH tunnel to forward remote Ollama :11434 to local :11435
export async function startTunnel(host = '213.192.2.89', port = 40011) {
  killTunnel()

  const args = [
    '-p', String(port),
    '-N',
    '-L', '11435:127.0.0.1:11434',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-i', SSH_KEY_PATH,
    `root@${host}`,
  ]

  tunnelProcess = spawn('ssh', args, { windowsHide: true })

  tunnelProcess.on('close', () => {
    tunnelProcess = null
  })

  tunnelProcess.on('error', () => {
    tunnelProcess = null
  })

  // Poll local tunnel port until responsive (up to 45 seconds)
  const start = Date.now()
  while (Date.now() - start < 45000) {
    try {
      const r = await fetch('http://127.0.0.1:11435/api/tags', { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

export function killTunnel() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGKILL')
    } catch {}
    tunnelProcess = null
  }
}

// High-level switch to Turbo
export async function switchToTurbo({ podId = RUNPOD_POD_ID } = {}) {
  // 1. Fetch pod state
  let pod = await fetchPodDetails(podId)

  // 2. If exited/stopped, start it
  if (pod.status !== 'RUNNING') {
    await startRunpodPod(podId)
    // Wait for pod to become RUNNING with public SSH ports
    const waitStart = Date.now()
    while (Date.now() - waitStart < 120000) {
      await new Promise((r) => setTimeout(r, 4000))
      pod = await fetchPodDetails(podId)
      if (pod.status === 'RUNNING' && pod.runtime?.ports?.some((p) => p.private === 22)) {
        break
      }
    }
  }

  // Extract direct SSH host and public port
  const sshPortEntry = pod.runtime?.ports?.find((p) => p.private === 22)
  const sshHost = sshPortEntry?.ip || pod.ssh?.direct?.host || '213.192.2.89'
  const sshPort = sshPortEntry?.public || pod.ssh?.direct?.port || 40011

  // 3. Establish tunnel to port 11435
  const tunnelOk = await startTunnel(sshHost, sshPort)
  currentMode = 'turbo'

  return {
    mode: 'turbo',
    podId,
    tunnelOk,
    url: 'http://127.0.0.1:11435',
    message: tunnelOk ? 'Connected to Runpod GPU (fast, 30–65 tok/s)' : 'Pod is running, waiting for Ollama tunnel...',
  }
}

// High-level switch to Always On
export async function switchToAlwaysOn({ stopPod = false } = {}) {
  if (stopPod) {
    try {
      await stopRunpodPod()
    } catch {}
  } else {
    killTunnel()
  }
  currentMode = 'always_on'
  return {
    mode: 'always_on',
    url: HOSTINGER_OLLAMA_URL,
    message: 'Connected to KVM 8 (2–5 tok/s, 24/7 flat)',
  }
}
