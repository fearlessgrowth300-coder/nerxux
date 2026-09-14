import test from 'node:test'
import assert from 'node:assert/strict'
import { extractToolCallsFromText, parseToolObject } from '../lib/agentLoop.js'

// The malformed shapes Qwen 27B actually emits, which strict JSON.parse dropped.
test('recovers single-quoted, Python-style, and trailing-comma tool calls', () => {
  const cases = [
    // single quotes
    [`{'tool': 'read_file', 'path': 'app/main.py'}`, 'read_file', { path: 'app/main.py' }],
    // Python booleans + trailing comma
    [`{"tool": "execute_command", "command": "ls", "background": True,}`, 'execute_command', { background: true }],
    // None -> null
    [`{"tool": "read_file", "path": "x", "start": None}`, 'read_file', { start: null }],
    // prose wrapped around it
    [`Sure, I'll do that.\n{"tool":"list_files","path":"."}\nRunning now.`, 'list_files', { path: '.' }],
    // fenced code block
    ['```json\n{"tool":"write_file","path":"a.txt","content":"hi"}\n```', 'write_file', { content: 'hi' }],
  ]
  for (const [text, name, argsSubset] of cases) {
    const calls = extractToolCallsFromText(text)
    assert.equal(calls.length, 1, `expected 1 call from: ${text}`)
    assert.equal(calls[0].name, name)
    for (const [k, v] of Object.entries(argsSubset)) assert.deepEqual(calls[0].args[k], v, `${name}.${k}`)
  }
})

test('valid JSON is untouched and unknown tools are ignored', () => {
  assert.deepEqual(parseToolObject('{"tool":"read_file","path":"x"}'), { tool: 'read_file', path: 'x' })
  assert.equal(extractToolCallsFromText('{"tool":"not_a_real_tool","x":1}').length, 0)
  assert.equal(extractToolCallsFromText('just some prose, no tools here').length, 0)
})

test('does not corrupt a double-quoted string that contains an apostrophe or the word True', () => {
  const calls = extractToolCallsFromText(`{"tool":"write_file","path":"a.py","content":"it's True that x='y'"}`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.content, "it's True that x='y'")
})

test('two calls in one message are both recovered', () => {
  const calls = extractToolCallsFromText(`{"tool":"read_file","path":"a"}\n{'tool':'read_file','path':'b'}`)
  assert.deepEqual(calls.map((c) => c.args.path), ['a', 'b'])
})
