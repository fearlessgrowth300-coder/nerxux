import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileToolCommand } from '../lib/agentTools.js'
import { fileMutationCommand } from '../lib/fileMutation.js'
import { transferAgentFile } from '../lib/agentTransfer.js'

const linux = process.platform === 'linux'
const shell = command => execFileSync('bash', ['-o', 'pipefail', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('invalid Python and JS edits preserve the previous file; hashes describe the bytes actually written', { skip: !linux }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-syntax-'))
  try {
    for (const [name, valid, invalid] of [['a.py', 'print("ok")\n', 'print("unterminated)'], ['a.js', 'console.log("ok")\n', 'const = ;']]) {
      const destination = path.join(dir, name)
      const output = shell(fileToolCommand('write_file', { path: destination, content: valid }))
      const receipt = JSON.parse(output.trim().split('\n').at(-1))
      assert.equal(receipt.bytes, Buffer.byteLength(valid))
      assert.match(receipt.sha256, /^[a-f0-9]{64}$/)
      assert.match(receipt.syntax, /passed/)
      assert.throws(() => shell(fileToolCommand('edit_file', { path: destination, old: valid, new: invalid })))
      assert.equal(await fs.readFile(destination, 'utf8'), valid)
      assert.throws(() => shell(fileToolCommand('write_file', { path: destination, content: invalid })))
      assert.equal(await fs.readFile(destination, 'utf8'), valid)
    }
    assert.ok(!(await fs.readdir(dir)).some(n => n.startsWith('.nexus-check-')))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('transfer recipe verifies receipt and rejects corrupt payloads and out-of-project sources', { skip: !linux }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-transfer-'))
  try {
    const project = path.join(dir, 'source'), destination = path.join(dir, "pod's folder", 'copy.py')
    await fs.mkdir(project)
    await fs.writeFile(path.join(project, 'a.py'), 'print("copied")\n')
    const remote = async command => ({ ok: true, exitCode: 0, stdout: shell(command), stderr: '', host: 'test-only-remote' })
    const input = { args: { path: 'a.py', destination }, projectPath: project }
    const result = await transferAgentFile(input, remote)
    assert.ok(result.ok)
    assert.match(result.stdout, /Verified transfer/)
    assert.equal(await fs.readFile(destination, 'utf8'), 'print("copied")\n')
    assert.throws(() => shell(fileMutationCommand('write_file', { content: 'print("bad")', sha256: '0'.repeat(64) }, destination)))
    assert.equal(await fs.readFile(destination, 'utf8'), 'print("copied")\n')
    await assert.rejects(transferAgentFile(input, async () => ({ ok: true, stdout: '{"bytes":0,"sha256":"wrong"}' })), /differs/)
    await fs.symlink(destination, path.join(project, 'escape.py'))
    await assert.rejects(transferAgentFile({ ...input, args: { ...input.args, path: 'escape.py' } }, remote), /inside the current project/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
