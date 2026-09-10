import test from 'node:test'
import assert from 'node:assert/strict'
import { queuedJobHint } from '../lib/mcp.js'

// This is the exact text Higgsfield returned. The model read it as success and
// told the user "Here it is!" over an image that did not exist yet.
const HIGGSFIELD = `Note: adjustments applied — params.resolution: "(unset)" → "1k".

Submitted 1 job. If a widget is visible, it polls automatically — do not call job_status or show_generations as a follow-up poll. In text-only clients, use job_status with sync:true to poll for completion.
- 0cca309b-1e7a-4e9b-9a75-4a95e13be1c8  "A bioluminescent deep-sea jellyfish"`

test('a queued job is flagged as NOT finished', () => {
  const hint = queuedJobHint(HIGGSFIELD)
  assert.match(hint, /only QUEUED/)
  assert.match(hint, /job_status with sync:true/)
  assert.match(hint, /Do NOT tell the user it is ready/)
})

test('a result that already carries a link is left alone', () => {
  assert.equal(queuedJobHint('Done: https://cdn.example/out.png'), '')
  assert.equal(queuedJobHint('job_id abc but here it is https://cdn.example/a'), '')
})

test('ordinary results are untouched', () => {
  assert.equal(queuedJobHint('Here are the 3 files in that folder.'), '')
  assert.equal(queuedJobHint(''), '')
})
