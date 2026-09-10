import test from 'node:test'
import assert from 'node:assert/strict'

// Ollama rejects a tool call it cannot parse, which is what a call cut off
// part-way looks like. The exact wording the user hit:
//   "XML syntax error on line 3: unexpected end element </function>"
const MALFORMED_TOOL_CALL = /XML syntax error|unexpected end element|invalid character|unmarshal|failed to parse tool/i

test('the parse failures Ollama actually reports are recognised', () => {
  for (const msg of [
    'XML syntax error on line 3: unexpected end element </function>',
    'json: cannot unmarshal string into Go value of type api.ToolCall',
    'invalid character \'<\' looking for beginning of value',
    'failed to parse tool call',
  ]) {
    assert.ok(MALFORMED_TOOL_CALL.test(msg), `should be recognised: ${msg}`)
  }
})

test('unrelated errors are not swallowed as parse failures', () => {
  for (const msg of [
    'model "orcarouter/Qwen3.8-27B-Uncensored:latest" not found, try pulling it first',
    'context deadline exceeded',
    'out of memory',
  ]) {
    assert.equal(MALFORMED_TOOL_CALL.test(msg), false, `should NOT be treated as a parse failure: ${msg}`)
  }
})

// The regression that caused it: Always On kept a cap a third the size of the
// one already found to be too small for a file-writing tool call.
test('Always On has room for a real tool call', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile('./adapters/ollama.js', 'utf8'))
  const line = src.split('\n').find((l) => l.includes('const numPredict = isRunpod'))
  const [, turbo, always] = line.match(/isRunpod \? (\d+) : (\d+)/)
  assert.ok(Number(always) >= 3000, `Always On cap ${always} is too small for a write_file call`)
  assert.ok(Number(turbo) > Number(always), 'Turbo should still get the bigger budget')
})
