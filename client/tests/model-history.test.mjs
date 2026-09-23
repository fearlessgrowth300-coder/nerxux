import test from 'node:test'
import assert from 'node:assert/strict'
import { modelHistory } from '../src/lib/modelHistory.js'

test('the next turn receives bounded tool evidence while full results stay addressable by ID', () => {
  const messages = [
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: 'Done', toolSteps: [{ evidenceId: 42, tool: 'execute_command', args: { command: 'npm test' }, ok: true, exitCode: 0, stdout: 'PASS ' + 'x'.repeat(10000) }] },
    { role: 'user', content: 'continue' },
  ]
  const history = modelHistory(messages)
  assert.equal(history[1].role, 'assistant')
  assert.match(history[1].content, /#42 execute_command npm test: ok \(exit 0\) PASS/)
  assert.match(history[1].content, /inspect_execution with an evidence ID/)
  assert.ok(history[1].content.length < 500)
  assert.equal(messages[1].content, 'Done', 'saved chat is not modified')
})
