import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { AGENT_TOOL_DEFS, AGENT_TOOL_NAMES, toOpenAITools, fileToolCommand, observationText } from '../lib/agentTools.js'

test('tool defs convert to OpenAI function format and the name set covers them all', () => {
  const oa = toOpenAITools(AGENT_TOOL_DEFS)
  assert.equal(oa.length, AGENT_TOOL_DEFS.length)
  assert.equal(oa[0].type, 'function')
  assert.equal(oa[0].function.name, AGENT_TOOL_DEFS[0].name)
  for (const t of AGENT_TOOL_DEFS) assert.equal(AGENT_TOOL_NAMES.has(t.name), true, t.name)
  assert.equal(AGENT_TOOL_NAMES.has('web_search'), true)
})

test('a relative path resolves against the given base — /workspace/project when a local folder is mounted, /workspace otherwise', () => {
  assert.match(fileToolCommand('write_file', { path: 'a.js', content: 'x' }, { base: '/workspace/project' }), /> '\/workspace\/project\/a\.js'/)
  assert.match(fileToolCommand('write_file', { path: 'a.js', content: 'x' }), /> '\/workspace\/a\.js'/) // default base, unchanged
  assert.match(fileToolCommand('list_files', {}, { base: '/workspace/project' }), /cd '\/workspace\/project'/) // empty path -> the base itself
  assert.match(fileToolCommand('read_file', { path: '/abs/x.js' }, { base: '/workspace/project' }), /'\/abs\/x\.js'/) // absolute path ignores base
})

test('file tool commands never embed model text as shell syntax', () => {
  const nasty = `it's "quoted" $(rm -rf /) \`x\` \n\t; echo pwned`
  const w = fileToolCommand('write_file', { path: "repo/a b'c.txt", content: nasty })
  assert.doesNotMatch(w, /rm -rf/)
  assert.doesNotMatch(w, /pwned/)
  const e = fileToolCommand('edit_file', { path: 'x.txt', old: nasty, new: nasty })
  assert.doesNotMatch(e, /rm -rf/)
  // The grep pattern is passed as a single-quoted literal: the embedded quote
  // is escaped and nothing inside can expand.
  const s = fileToolCommand('search_files', { pattern: nasty, path: '/workspace' })
  assert.match(s, /-E 'it'\\''s "quoted" \$\(rm -rf \/\)/)
  assert.equal(fileToolCommand('execute_command', {}), null)
})

// bash is available on this machine (Git Bash on Windows / native elsewhere):
// run the real recipes against a temp dir to prove they round-trip content.
const bashAvailable = (() => { try { execFileSync('bash', ['-c', 'true']); return true } catch { return false } })()
test('write/read/edit/list/search round-trip real content through bash', { skip: !bashAvailable }, () => {
  // A POSIX temp dir stands in for /workspace (the recipes are the same
  // strings the sandbox runs; only the root differs).
  const ws = execFileSync('bash', ['-c', 'mktemp -d'], { encoding: 'utf8' }).trim()
  const run = (cmd) => execFileSync('bash', ['-c', cmd.replace(/\/workspace/g, ws)], { encoding: 'utf8' })
  const content = 'line one\nconst s = "it\'s `tricky` $HOME";\n// done\n'
  assert.match(run(fileToolCommand('write_file', { path: 't/a.js', content })), /wrote .*t\/a\.js/)
  assert.match(run(fileToolCommand('read_file', { path: 't/a.js' })), /2\s+const s = "it's `tricky` \$HOME";/)
  assert.match(run(fileToolCommand('edit_file', { path: 't/a.js', old: '// done', new: '// finished' })), /edited/)
  assert.match(run(fileToolCommand('search_files', { pattern: 'finished', path: 't' })), /a\.js:3:\/\/ finished/)
  assert.match(run(fileToolCommand('list_files', { path: 't' })), /a\.js/)
  assert.throws(() => run(fileToolCommand('edit_file', { path: 't/a.js', old: 'nope', new: 'x' })))
})

test('observations read naturally for file tools and like a terminal for commands', () => {
  assert.equal(observationText('write_file', { ok: true, stdout: 'wrote /workspace/a (3 bytes)', stderr: '' }), 'wrote /workspace/a (3 bytes)')
  assert.match(observationText('read_file', { ok: false, stdout: '', stderr: 'No such file' }), /^Error: No such file/)
  assert.match(observationText('execute_command', { ok: true, exitCode: 0, stdout: 'hi', stderr: '', target: 'sandbox' }), /Exit Code: 0[\s\S]*hi/)
})
