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
  assert.match(fileToolCommand('read_file', { path: 'a.js' }, { base: '/workspace/project' }), /'\/workspace\/project\/a\.js'/)
  assert.match(fileToolCommand('read_file', { path: 'a.js' }), /'\/workspace\/a\.js'/) // default base, unchanged
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
const bashAvailable = process.platform !== 'win32' && (() => { try { execFileSync('bash', ['-c', 'true']); return true } catch { return false } })()
test('write/read/edit/list/search round-trip real content through bash', { skip: !bashAvailable }, () => {
  // A POSIX temp dir stands in for /workspace (the recipes are the same
  // strings the sandbox runs; only the root differs).
  const ws = execFileSync('bash', ['-c', 'mktemp -d'], { encoding: 'utf8' }).trim()
  const run = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8' })
  const recipe = (name, args) => fileToolCommand(name, args, { base: ws })
  const content = '// line one\nconst s = "it\'s `tricky` $HOME";\n// done\n'
  assert.match(run(recipe('write_file', { path: 't/a.js', content })), /wrote .*t\/a\.js/)
  assert.match(run(recipe('read_file', { path: 't/a.js' })), /2\s+const s = "it's `tricky` \$HOME";/)
  assert.match(run(recipe('edit_file', { path: 't/a.js', old: '// done', new: '// finished' })), /edited/)
  assert.match(run(recipe('search_files', { pattern: 'finished', path: 't' })), /a\.js:3:\/\/ finished/)
  assert.match(run(recipe('list_files', { path: 't' })), /a\.js/)
  assert.throws(() => run(recipe('edit_file', { path: 't/a.js', old: 'nope', new: 'x' })))
})

test('observations read naturally for file tools and like a terminal for commands', () => {
  assert.equal(observationText('write_file', { ok: true, stdout: 'wrote /workspace/a (3 bytes)', stderr: '' }), 'wrote /workspace/a (3 bytes)')
  assert.match(observationText('read_file', { ok: false, stdout: '', stderr: 'No such file' }), /^Error: No such file/)
  assert.match(observationText('execute_command', { ok: true, exitCode: 0, stdout: 'hi', stderr: '', target: 'sandbox' }), /Exit Code: 0[\s\S]*hi/)
})

test('command observations preserve stderr when stdout is also present', () => {
  const text = observationText('execute_command', {
    ok: false, exitCode: 1, stdout: 'Starting check', stderr: 'TypeError: wrong response shape',
  })
  assert.match(text, /Exit Code: 1/)
  assert.match(text, /Starting check/)
  assert.match(text, /Stderr:\nTypeError: wrong response shape/)
  assert.doesNotMatch(observationText('execute_command', { ok: false, exitCode: 1 }), /succeeded/)
})

test('read_file preserves long source lines and notices an unterminated final line', { skip: !bashAvailable }, () => {
  const ws = execFileSync('bash', ['-c', 'mktemp -d'], { encoding: 'utf8' }).trim()
  const run = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8' })
  const content = 'x'.repeat(750) + 'END_OF_LINE\nlast line without newline'
  run(fileToolCommand('write_file', { path: `${ws}/long.txt`, content }))
  const first = run(fileToolCommand('read_file', { path: `${ws}/long.txt`, limit: 1 }))
  assert.ok(first.includes('x'.repeat(750) + 'END_OF_LINE'))
  assert.match(first, /2 lines total; showing 1-1/)
  assert.match(run(fileToolCommand('read_file', { path: `${ws}/long.txt`, start: 2 })), /last line without newline/)
})

// The user names the project by its host path and the model repeats it, but
// inside the sandbox the folder is mounted elsewhere — so a correct instruction
// came back as "No such folder: /root/viewe-account".
test('a host path inside the project resolves to the mount', () => {
  const cmd = fileToolCommand('read_file', { path: '/root/viewe-account/README.md' },
    { base: '/workspace/project', hostRoot: '/root/viewe-account' })
  assert.match(cmd, /\/workspace\/project\/README\.md/)
  assert.doesNotMatch(cmd, /\/root\/viewe-account\/README\.md/)
})

test('the project root itself resolves to the mount', () => {
  const cmd = fileToolCommand('list_files', { path: '/root/viewe-account' },
    { base: '/workspace/project', hostRoot: '/root/viewe-account' })
  assert.match(cmd, /'\/workspace\/project'/)
})

test('relative paths and unrelated absolute paths are unchanged', () => {
  const rel = fileToolCommand('read_file', { path: 'app/main.py' },
    { base: '/workspace/project', hostRoot: '/root/viewe-account' })
  assert.match(rel, /\/workspace\/project\/app\/main\.py/)

  const other = fileToolCommand('read_file', { path: '/etc/hosts' },
    { base: '/workspace/project', hostRoot: '/root/viewe-account' })
  assert.match(other, /'\/etc\/hosts'/)
})

test('a path that merely starts with the same letters is not rewritten', () => {
  const cmd = fileToolCommand('read_file', { path: '/root/viewe-account-backup/x.md' },
    { base: '/workspace/project', hostRoot: '/root/viewe-account' })
  assert.match(cmd, /viewe-account-backup\/x\.md/)
  assert.doesNotMatch(cmd, /\/workspace\/project/)
})
