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
  const line = src.split('\n').find((l) => /\b(const|let) numPredict = isRunpod/.test(l))
  const [, turbo, always] = line.match(/isRunpod \? (\d+) : (\d+)/)
  assert.ok(Number(always) >= 3000, `Always On cap ${always} is too small for a write_file call`)
  assert.ok(Number(turbo) > Number(always), 'Turbo should still get the bigger budget')
  // A turn that falls back to Always On mid-way must use the same Always On cap.
  const fallback = src.match(/const fallBackToAlwaysOn = \(\) => \{[\s\S]*?numPredict = (\d+)/)
  assert.ok(fallback, 'fallBackToAlwaysOn should set numPredict')
  assert.equal(fallback[1], always, 'mid-turn fallback uses the Always On cap')
})

// The pod ran out of credit while a chat was open: RunPod exited it, the
// dashboard was closed so nothing polled, and every message went to the dead
// tunnel with "Can't reach Runpod GPU Ollama tunnel at 127.0.0.1:11435".
test('a chat turn checks Turbo and runs on Always On when the pod is gone', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile('./adapters/ollama.js', 'utf8'))
  assert.match(src, /if \(targetUrl\.includes\('11435'\) && !\(await ensureTurboReady\(\)\)\) \{\s*targetUrl = resolveTargetUrl\(model\)/,
    'before the first request, a failed Turbo check re-resolves the target instead of sending to 11435')
  assert.match(src, /if \(getComputeStatus\(\)\.mode !== 'turbo'\) \{\s*fallBackToAlwaysOn\(\)/,
    'a tunnel that dies mid-turn moves the turn to Always On instead of throwing')
  const cm = await import('node:fs').then((fs) => fs.promises.readFile('./lib/computeManager.js', 'utf8'))
  const fn = cm.match(/export async function ensureTurboReady\(\) \{[\s\S]*?\n\}/)[0]
  assert.match(fn, /pod\.status === 'RUNNING'/, 'only reconnects to a running pod')
  assert.match(fn, /setCurrentMode\('always_on'\)/, 'falls back to Always On otherwise')
  assert.doesNotMatch(fn, /startRunpodPod/, 'a chat turn never starts (and bills) a stopped pod by itself')
})
