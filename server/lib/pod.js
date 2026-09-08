import { exec } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// SSH runner for executing commands directly on the user's Runpod GPU pod.
// Host: 213.192.2.89:40011 (or naomdzahw3yqeu-64410b31@ssh.runpod.io)
// Identity: ~/.ssh/id_ed25519

const RUNPOD_IP = process.env.RUNPOD_IP || '213.192.2.89'
const RUNPOD_PORT = process.env.RUNPOD_PORT || '40011'
const RUNPOD_USER = process.env.RUNPOD_USER || 'root'
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519')

export async function runOnPod(command, { timeoutMs = 45000, cwd } = {}) {
  const startTime = Date.now()
  const cleanCmd = cwd ? `cd ${cwd} && ${command}` : command

  // Safely escape the remote command
  const b64 = Buffer.from(cleanCmd, 'utf-8').toString('base64')
  const remoteExec = `echo "${b64}" | base64 -d | bash`

  const sshCmd = `ssh -p ${RUNPOD_PORT} -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 -i "${SSH_KEY_PATH}" ${RUNPOD_USER}@${RUNPOD_IP} "${remoteExec}"`

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
          host: `${RUNPOD_USER}@${RUNPOD_IP}:${RUNPOD_PORT}`,
        })
      } else {
        resolve({
          ok: true,
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: 0,
          durationMs,
          target: 'pod',
          host: `${RUNPOD_USER}@${RUNPOD_IP}:${RUNPOD_PORT}`,
        })
      }
    })
  })
}
