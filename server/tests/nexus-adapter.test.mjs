import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Reproduces the actual bug: the user's Model A got set to "Nexus
// (from-scratch)" — a separate experimental model with no trained weights on
// the VPS — and sending "continue" three times gave, three times, "Can't
// reach your local model at http://127.0.0.1:4500, and auto-start failed. Run
// it manually: cd nexus-model && python serve.py". That is a command for a
// terminal the user, on a hosted server, does not have.
const { hasCheckpoint } = await import('../lib/modelServer.js')
const { run, health, NO_CHECKPOINT_MESSAGE } = await import('../adapters/nexus.js')

test('hasCheckpoint() reports what is actually on disk', () => {
  const real = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'nexus-model', 'out')
  assert.equal(hasCheckpoint(), fs.existsSync(real))
})

// The message itself, regardless of which machine runs the suite: this is
// what a user on a checkpoint-less server (the VPS) actually sees.
test('the no-checkpoint message points at the real fix, not a local command', () => {
  assert.doesNotMatch(NO_CHECKPOINT_MESSAGE, /python serve\.py/, 'must not tell a hosted user to run a terminal command')
  assert.match(NO_CHECKPOINT_MESSAGE, /switch model A/i, 'must say what to actually do')
  assert.match(NO_CHECKPOINT_MESSAGE, /Qwen/i, 'must name a working model to switch to')
})

// Exercised for real only when this machine has no checkpoint (the VPS's
// actual state); on a dev machine with one, the guard is proven by the two
// tests above plus the live check against the deployed server.
test('with no trained checkpoint, run() and health() fail fast with that message', { skip: hasCheckpoint() }, async () => {
  const t0 = Date.now()
  await assert.rejects(() => run({ prompt: 'hi' }), new RegExp(NO_CHECKPOINT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.ok(Date.now() - t0 < 500, 'must fail before any real network attempt')

  const h = await health()
  assert.equal(h.reachable, false)
  assert.equal(h.message, NO_CHECKPOINT_MESSAGE)
})
