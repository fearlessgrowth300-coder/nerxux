import dotenv from 'dotenv'
import https from 'node:https'
import http from 'node:http'
import { spawn, exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../.env') })

const execAsync = promisify(exec)

// Compute modes:
// 1. "always_on": Hostinger KVM 8 VPS (2-5 tok/s, 24/7 flat $26/mo)
// 2. "turbo": Runpod RTX 3090 GPU (30-65 tok/s, on-demand $0.50/hr)

const getApiKey = () => process.env.RUNPOD_API_KEY || ''
const getPodId = () => process.env.RUNPOD_POD_ID || 'rigdm6buq51pnu'
let HOSTINGER_OLLAMA_URL = process.env.HOSTINGER_OLLAMA_URL || 'http://2.25.126.125:11434'
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519')

let currentMode = 'always_on' // 'always_on' | 'turbo'
let tunnelProcess = null
let currentPodInfo = null

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
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export function getComputeStatus() {
  return {
    mode: currentMode,
    hostingerUrl: HOSTINGER_OLLAMA_URL,
    runpodPodId: getPodId(),
    runpodActive: Boolean(tunnelProcess),
    activeUrl: currentMode === 'turbo' ? 'http://127.0.0.1:11435' : HOSTINGER_OLLAMA_URL,
    details:
      currentMode === 'turbo'
        ? {
            label: 'Turbo (Runpod RTX 3090)',
            speed: '30–65 tok/s',
            cost: '$0.50/hr',
            status: tunnelProcess ? 'ready' : 'connecting',
          }
        : {
            label: 'Always On (KVM 8)',
            speed: '2–5 tok/s',
            cost: '$26/mo flat',
            status: 'ready',
          },
  }
}

export function setHostingerIp(ipOrUrl) {
  if (!ipOrUrl) return
  const clean = ipOrUrl.trim()
  HOSTINGER_OLLAMA_URL = clean.startsWith('http') ? clean : `http://${clean}:11434`
  return HOSTINGER_OLLAMA_URL
}

// Fetch live pod status from Runpod REST v2 API
export async function fetchPodDetails(podId = getPodId()) {
  const data = await runpodRequest(`/pods/${podId}`)
  currentPodInfo = data
  return data
}

// Start Runpod Pod
export async function startRunpodPod(podId = getPodId()) {
  return runpodRequest(`/pods/${podId}/action`, {
    method: 'POST',
    body: { action: 'start' },
  })
}

// Stop Runpod Pod (halts hourly billing)
export async function stopRunpodPod(podId = getPodId()) {
  killTunnel()
  const result = await runpodRequest(`/pods/${podId}/action`, {
    method: 'POST',
    body: { action: 'stop' },
  })
  currentMode = 'always_on'
  return result
}

// Helper: check if http://127.0.0.1:11435/api/tags responds
function checkLocalTunnelPort() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:11435/api/tags', { timeout: 1500 }, (res) => {
      resolve(res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

// Start SSH tunnel to forward remote Ollama :11434 to local :11435
export async function startTunnel(host = '213.192.2.75', port = 40072) {
  killTunnel()

  // Ensure remote Ollama is running in background on the pod
  try {
    const startOllamaCmd = `ssh -p ${port} -o StrictHostKeyChecking=no -o ConnectTimeout=8 -i "${SSH_KEY_PATH}" root@${host} "pgrep ollama >/dev/null || (nohup ollama serve >/tmp/ollama.log 2>&1 &)"`
    await execAsync(startOllamaCmd).catch(() => {})
  } catch {}

  const args = [
    '-p',
    String(port),
    '-N',
    '-L',
    '11435:127.0.0.1:11434',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-i',
    SSH_KEY_PATH,
    `root@${host}`,
  ]

  tunnelProcess = spawn('ssh', args, { windowsHide: true })

  tunnelProcess.on('close', () => {
    tunnelProcess = null
  })

  tunnelProcess.on('error', () => {
    tunnelProcess = null
  })

  // Poll local tunnel port until responsive (up to 30 seconds)
  const start = Date.now()
  while (Date.now() - start < 30000) {
    const ok = await checkLocalTunnelPort()
    if (ok) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return true // tunnel launched
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
export async function switchToTurbo({ podId = getPodId() } = {}) {
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
  const sshHost = sshPortEntry?.ip || pod.ssh?.direct?.host || '213.192.2.75'
  const sshPort = sshPortEntry?.public || pod.ssh?.direct?.port || 40072

  // 3. Establish tunnel to port 11435
  const tunnelOk = await startTunnel(sshHost, sshPort)
  currentMode = 'turbo'

  return {
    mode: 'turbo',
    podId,
    tunnelOk,
    url: 'http://127.0.0.1:11435',
    message: tunnelOk
      ? 'Connected to Runpod GPU (fast, 30–65 tok/s)'
      : 'Pod is running, establishing Ollama connection...',
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
