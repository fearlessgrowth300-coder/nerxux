import test from 'node:test'
import assert from 'node:assert/strict'
import { _friendlyError, _blockedMessage, _safeFunctionCalls, _safeText } from '../adapters/gemini.js'

// A blocked Gemini response used to take down the whole turn: the SDK throws
// from functionCalls()/text() when there is no usable candidate, and the raw
// "Response was blocked due to OTHER" told the user nothing to act on.
const throwing = { functionCalls: () => { throw new Error('Function call not available. Response was blocked due to OTHER') },
  text: () => { throw new Error('Response was blocked due to OTHER') } }

test('a blocked response ends the tool loop instead of throwing', () => {
  assert.deepEqual(_safeFunctionCalls(throwing), [])
  assert.equal(_safeText(throwing), '')
})

test('block reasons become something the user can act on', () => {
  assert.match(_blockedMessage({ candidates: [{ finishReason: 'SAFETY' }] }, 'gemini-3.8-flash', false), /safety filters/)
  assert.match(_blockedMessage({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'gemini-3.8-flash', false), /output limit/)
  const other = _blockedMessage({ candidates: [{ finishReason: 'OTHER' }] }, 'gemini-3.8-flash', true)
  assert.match(other, /OTHER/)
  assert.match(other, /turning off connectors|Claude or GPT/)
})

// Google returns a ~12s retryDelay even when the exhausted quota is the DAILY
// one, so the old message sent people retrying for the rest of the day.
test('a used-up daily free quota is not reported as "retry in 12s"', () => {
  const raw = 'Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: ' +
    '[429 Too Many Requests] Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
    'limit: 20, model: gemini-3.8-flash Please retry in 11.18078201s. "quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"'
  const m = _friendlyError(new Error(raw)).message
  assert.match(m, /daily limit of 20 requests/)
  assert.match(m, /gemini-3\.8-flash/)
  assert.doesNotMatch(m, /retry in ~/)
})

test('a per-minute rate limit still says to wait', () => {
  const m = _friendlyError(new Error('[429 Too Many Requests] rate limit. Please retry in 8s.')).message
  assert.match(m, /retry in ~8s/)
})

test('a zero free-tier quota points at billing, not at waiting', () => {
  const m = _friendlyError(new Error('[429] Quota exceeded, limit: 0, model: gemini-3.8-flash')).message
  assert.match(m, /free tier is not enabled/)
})
