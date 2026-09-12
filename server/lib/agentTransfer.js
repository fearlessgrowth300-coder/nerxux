import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runOnPod } from './pod.js'
import { fileMutationCommand } from './fileMutation.js'

export async function transferAgentFile({ args, projectPath, sessionId }, remote = runOnPod) {
  if (process.platform !== 'linux') throw new Error('Verified pod transfers currently require a Linux Nexus host')
  const session = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const root = await fs.realpath(projectPath || `/tmp/nexus_sandbox/${session}/work`)
  let requested = String(args.path || '')
  const mount = projectPath ? '/workspace/project' : '/workspace'
  if (requested.startsWith(mount + '/')) requested = requested.slice(mount.length + 1)
  const source = await fs.realpath(path.resolve(root, requested))
  if (!source.startsWith(root + path.sep)) throw new Error('Transfer source must be inside the current project (including resolved symlinks)')
  const destination = String(args.destination || '')
  if (!destination.startsWith('/') || /[\x00-\x1f]/.test(destination)) throw new Error('Transfer destination must be an absolute pod file path')
  if (/(^|\/)(\.env(?:\.|$)|\.ssh|id_rsa|id_ed25519)|\.(pem|key|p12|pfx)$/i.test(source)) throw new Error('Use dedicated credential provisioning for secret files; do not copy them through agent transfers')
  const stat = await fs.stat(source)
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Transfer one regular source file of at most 256 KiB')
  const data = await fs.readFile(source)
  if (data.length > 256 * 1024) throw new Error('Source changed size while reading; inspect and retry')
  const sha256 = createHash('sha256').update(data).digest('hex')
  const result = await remote(fileMutationCommand('write_file', { base64: data.toString('base64'), sha256, bytes: data.length }, destination))
  if (!result.ok) return result
  let receipt
  try { receipt = JSON.parse(result.stdout.trim().split('\n').at(-1)) } catch { throw new Error('Remote copy returned no valid verification receipt') }
  if (receipt.sha256 !== sha256 || receipt.bytes !== data.length) throw new Error('Remote checksum/size differs from source; transfer is unverified')
  return { ...result, stdout: `Verified transfer from ${source} to ${result.host || 'pod'}:${receipt.path}\n${JSON.stringify(receipt)}` }
}
