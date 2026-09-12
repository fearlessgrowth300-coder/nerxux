import { spawn } from 'node:child_process'
import { redactSecrets } from './redact.js'
import os from 'node:os'
import path from 'node:path'
import { fetchPodDetails } from './computeManager.js'
import { podSshEndpoint } from './ollamaTunnel.js'

// SSH runner for executing commands directly on the user's Runpod GPU pod.
// RunPod assigns a NEW public SSH port every time a stopped pod is restarted,
// so the endpoint can't be hardcoded — resolve it live from the RunPod API
// each call. RUNPOD_IP/RUNPOD_PORT env vars remain as a last-resort fallback
// (e.g. the RunPod API being briefly unreachable).
const RUNPOD_USER = process.env.RUNPOD_USER || 'root'
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519')

async function resolveEndpoint() {
  try {
    const pod = await fetchPodDetails()
    const live = podSshEndpoint(pod)
    if (live) return live
  } catch {}
  if (process.env.RUNPOD_IP && process.env.RUNPOD_PORT) {
    return { host: process.env.RUNPOD_IP, port: Number(process.env.RUNPOD_PORT) }
  }
  return null
}

export async function runOnPod(command, { timeoutMs = 45000, cwd } = {}) {
  const startTime = Date.now()
  const endpoint = await resolveEndpoint()
  if (!endpoint) {
    return {
      ok: false,
      stdout: '',
      stderr: 'RunPod pod is not running (or its SSH endpoint could not be resolved). Switch to Turbo first.',
      exitCode: 1,
      durationMs: Date.now() - startTime,
      target: 'pod',
      host: null,
    }
  }
  const { host, port } = endpoint
  const quote = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'"
  const script = (cwd ? `cd -- ${quote(cwd)} || exit $?\n` : '') + command + '\n'
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false
    const proc = spawn('ssh', ['-p', String(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', SSH_KEY_PATH, `${RUNPOD_USER}@${host}`, 'bash -o pipefail -s'], { windowsHide: true })
    const timer = setTimeout(() => { timedOut = true; proc.kill() }, timeoutMs)
    const finish = (code, error = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: !timedOut && code === 0, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr + error + (timedOut ? '\nSSH command timed out' : '')), exitCode: timedOut ? 124 : code ?? 1, durationMs: Date.now() - startTime, target: 'pod', host: `${RUNPOD_USER}@${host}:${port}`, cwd: cwd || '(remote default)' })
    }
    proc.stdout.on('data', d => { stdout += d; if (stdout.length > 500000) { stdout = stdout.slice(0, 500000); proc.kill() } })
    proc.stderr.on('data', d => { stderr += d; if (stderr.length > 500000) { stderr = stderr.slice(0, 500000); proc.kill() } })
    proc.on('error', e => finish(1, e.message))
    proc.on('close', code => finish(code))
    proc.stdin.on('error', () => {}) // an early SSH failure is reported by close
    proc.stdin.end(script)
  })
}
