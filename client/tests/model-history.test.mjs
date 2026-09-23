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
  assert.match(history[2].content, /#42 execute_command npm test: ok \(exit 0\) PASS/)
  assert.match(history[2].content, /inspect_execution with an evidence ID/)
  assert.ok(history[2].content.length < 500)
  assert.equal(messages[1].content, 'Done', 'saved chat is not modified')
})

test('an older relevant success stays pinned when newer turns have tool output', () => {
  const tool = (evidenceId, command, ok = true) => ({ evidenceId, tool: 'verify_work', args: { command }, ok, exitCode: ok ? 0 : 1, stdout: ok ? 'verified result' : 'failed' })
  const messages = [
    { role: 'user', content: 'make the parser fast' },
    { role: 'assistant', content: 'Parser benchmark passed', toolSteps: [tool(7, 'parser benchmark')] },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'Unrelated', toolSteps: [tool(8, 'css check')] },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'Unrelated again', toolSteps: [tool(9, 'layout check')] },
    { role: 'user', content: 'continue' },
  ]
  const history = modelHistory(messages)
  assert.match(history.at(-1).content, /#7 verify_work parser benchmark/)
  assert.ok(history.at(-1).content.length < 4000)
})
