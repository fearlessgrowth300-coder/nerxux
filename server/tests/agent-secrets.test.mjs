import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileToolCommand } from '../lib/agentTools.js'

test('write_file to an env-shaped path also ensures a .gitignore covers it', () => {
  const cmd = fileToolCommand('write_file', { path: 'repo/.env.local', content: 'SUPABASE_KEY=x' })
  assert.match(cmd, /GI="\$D\/\.gitignore"/)
  assert.match(cmd, /'\.env\*'/)
  // A plain source file gets no such guard.
  const plain = fileToolCommand('write_file', { path: 'repo/src/app.ts', content: 'x' })
  assert.doesNotMatch(plain, /gitignore/i)
})

const bashAvailable = (() => { try { execFileSync('bash', ['-c', 'true']); return true } catch { return false } })()
test('write_file\'s .gitignore guard actually stops git from tracking the file', { skip: !bashAvailable }, () => {
  const ws = execFileSync('bash', ['-c', 'mktemp -d'], { encoding: 'utf8' }).trim()
  const run = (cmd) => execFileSync('bash', ['-c', `cd ${JSON.stringify(ws)} && git init -q -b main && ` + cmd], { encoding: 'utf8' })
  run(fileToolCommand('write_file', { path: `${ws}/.env.local`, content: 'SECRET=1' }))
  const status = execFileSync('bash', ['-c', `cd ${JSON.stringify(ws)} && git add -A && git status --porcelain`], { encoding: 'utf8' })
  assert.doesNotMatch(status, /\.env/) // ignored, so `git add -A` never staged it
})
