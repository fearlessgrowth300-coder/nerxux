import fs from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from './redact.js'

const optional = async file => { try { return await fs.readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } }
export async function sandboxJob({ sessionId, jobId, stop = false, offset = 0 }) {
  if (process.platform !== 'linux') throw new Error('Job polling currently requires the Linux Nexus host')
  if (!/^job_[a-zA-Z0-9_]+$/.test(jobId || '')) throw new Error('Invalid job ID')
  const session = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const root = path.join('/tmp/nexus_sandbox', session, '.jobs', jobId)
  const pid = Number((await optional(root + '.pid')).trim())
  const expectedStart = (await optional(root + '.started')).trim()
  const procStat = pid > 1 ? await optional(`/proc/${pid}/stat`) : ''
  // comm in /proc/stat can contain spaces; split after its final closing paren.
  const fields = procStat.slice(procStat.lastIndexOf(')') + 2).split(' ')
  const live = Boolean(expectedStart && fields[19] === expectedStart && !['Z', 'X'].includes(fields[0]))
  if (stop && live) {
    try { process.kill(-pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') throw e }
    await fs.writeFile(root + '.exit', '143', { mode: 0o600 })
  }
  const exitText = (await optional(root + '.exit')).trim()
  let stdout = '', nextOffset = Math.max(0, Number(offset) || 0)
  try {
    const handle = await fs.open(root + '.log', 'r')
    try {
      const stat = await handle.stat()
      nextOffset = Math.min(nextOffset, stat.size)
      const buffer = Buffer.alloc(Math.min(32000, stat.size - nextOffset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, nextOffset)
      stdout = redactSecrets(buffer.subarray(0, bytesRead).toString('utf8'))
      nextOffset += bytesRead
    } finally { await handle.close() }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const status = exitText ? 'completed' : live ? 'running' : 'interrupted'
  const exitCode = exitText ? Number(exitText) : status === 'running' ? null : 1
  return { ok: status === 'running' || exitCode === 0, exitCode, stdout, stderr: status === 'interrupted' ? 'Job process is no longer running and left no completion receipt; inspect before retrying.' : '', durationMs: 0, target: 'sandbox', job: { id: jobId, status, nextOffset } }
}
