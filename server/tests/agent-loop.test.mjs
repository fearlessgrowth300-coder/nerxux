import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolArgs, harvestGithubToken } from '../lib/agentLoop.js'

test('a GitHub token pasted in the chat is picked up (latest wins), nothing else matches', () => {
  const chat = 'here is the token ghp_' + 'A'.repeat(36) + ' and it for free\nlater: github_pat_' + 'B'.repeat(40) + ' use this one'
  assert.equal(harvestGithubToken(chat), 'github_pat_' + 'B'.repeat(40))
  assert.equal(harvestGithubToken('supabase key eyJhbGciOi... and postgresql://postgres:pw@db'), null)
  assert.equal(harvestGithubToken(''), null)
})
import { looksUnfinished } from '../adapters/ollama.js'

test('a tool-call object passed as the code string is unwrapped (escaped newlines)', () => {
  const wrapped = JSON.stringify({ language: 'python', code: '\nimport os\nprint(1)' })
  const a = normalizeToolArgs('run_code', { language: 'python', code: wrapped })
  assert.equal(a.code, '\nimport os\nprint(1)')
  assert.equal(a.language, 'python')
})

test('…and with literal newlines inside the strings', () => {
  const wrapped = '{"language":"python","code":"import os\nos.makedirs(\'app\')\n"}'
  const a = normalizeToolArgs('run_code', { language: 'python', code: wrapped })
  assert.equal(a.code, "import os\nos.makedirs('app')\n")
})

test('a wrapped command is unwrapped; real code and commands are untouched', () => {
  const c = normalizeToolArgs('execute_command', { command: '{"command":"ls -la /workspace/repo","target":"sandbox"}' })
  assert.equal(c.command, 'ls -la /workspace/repo')
  assert.equal(c.target, 'sandbox')
  const plain = normalizeToolArgs('run_code', { code: 'x = {"a": 1}\nprint(x)' })
  assert.equal(plain.code, 'x = {"a": 1}\nprint(x)')
  const cmd = normalizeToolArgs('execute_command', { command: 'echo {"not":"json"} | cat' })
  assert.equal(cmd.command, 'echo {"not":"json"} | cat')
})

test('turns that ask permission or announce an unexecuted step count as unfinished', () => {
  for (const t of [
    'Should I proceed with building the full app?',
    'Now let me build out all the application files. Starting with the core app structure:',
    'The Next.js project is scaffolded. Let me check what was created and start building the full app.',
    'Do you want me to push to GitHub now?',
  ]) assert.equal(looksUnfinished(t), true, t)
  for (const t of [
    'Done. The app is at /workspace/project and the build passes. Let me know if you need anything else.',
    'All files were created and pushed to main.',
    '',
  ]) assert.equal(looksUnfinished(t), false, t)
})
