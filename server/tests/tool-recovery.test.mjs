import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolRecovery } from '../lib/toolRecovery.js'

test('reads and patches do not count as a successful execution check', () => {
  const record = createToolRecovery()
  assert.equal(record('execute_command', { ok: false }), '')
  assert.equal(record('read_file', { ok: true }), '')
  assert.equal(record('edit_file', { ok: true }), '')
  assert.match(record('execute_command', { ok: false }), /Diagnostic checkpoint/)
  assert.equal(record('execute_command', { ok: true }), '')
  assert.equal(record('run_code', { ok: false }), '')
  assert.match(record('run_on_pod', { ok: false }), /minimal reproduction/)
})

test('failure tracking is isolated to a turn and ignores non-execution tools', () => {
  const a = createToolRecovery()
  const b = createToolRecovery()
  a('run_code', { ok: false })
  assert.equal(b('run_code', { ok: false }), '')
  assert.equal(a('web_search', { ok: false }), '')
  assert.match(a('run_code', { ok: false }), /Diagnostic checkpoint/)
})
