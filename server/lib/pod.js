import { exec } from 'node:child_process'
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
  const cleanCmd = cwd ? `cd ${cwd} && ${command}` : command

  // Safely escape the remote command
  const b64 = Buffer.from(cleanCmd, 'utf-8').toString('base64')
  const remoteExec = `echo "${b64}" | base64 -d | bash`

  const sshCmd = `ssh -p ${port} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -i "${SSH_KEY_PATH}" ${RUNPOD_USER}@${host} "${remoteExec}"`

  return new Promise((resolve) => {
    exec(sshCmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const durationMs = Date.now() - startTime
      if (err) {
        resolve({
          ok: false,
          stdout: stdout || '',
          stderr: stderr || err.message,
          exitCode: err.code || 1,
          durationMs,
          target: 'pod',
          host: `${RUNPOD_USER}@${host}:${port}`,
        })
      } else {
        resolve({
          ok: true,
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: 0,
          durationMs,
          target: 'pod',
          host: `${RUNPOD_USER}@${host}:${port}`,
        })
      }
    })
  })
}
