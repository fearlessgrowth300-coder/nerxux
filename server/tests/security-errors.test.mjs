import test from 'node:test'
import assert from 'node:assert/strict'
import { safeErrorMessage, logErrorSummary, errorStatus } from '../lib/safeErrors.js'
import { createJob, failJob, touchJob } from '../lib/chatJobs.js'
import { encrypt, decrypt } from '../lib/crypto.js'

test('operational logs contain selected metadata, not SDK bodies, prompts or secrets', () => {
  const error = Object.assign(new Error('private prompt and secret'), {status:429,code:'ETIMEDOUT',
    request:{headers:{Authorization:'Bearer private'},body:'private prompt'}})
  const logs = []
  logErrorSummary('requestFailed', error, {error:(...args)=>logs.push(args)})
  assert.deepEqual(logs, [['[nexus-ai]',{event:'requestFailed',status:429,code:'ETIMEDOUT'}]])
  logErrorSummary('requestFailed', {code:'unrecognized-secret-value'}, {error:(...args)=>logs.push(args)})
  assert.doesNotMatch(JSON.stringify(logs), /private|secret/)
  for (const status of [null, 0, 200, 999, '429']) assert.equal(errorStatus({status}),500)
})

test('API error text preserves useful wording while removing known environment secrets', () => {
  const secret = 'opaque-unprefixed-credential'
  const result = safeErrorMessage(new Error(`Authentication failed for ${secret}. Try again.`), 'Failed', {CUSTOM_API_KEY:secret})
  assert.equal(result, 'Authentication failed for ***. Try again.')
  assert.equal(safeErrorMessage({}, 'Failed', {}), 'Failed')
  const longSecret = 'a'.repeat(2100)
  assert.equal(safeErrorMessage(new Error(longSecret), 'Failed', {CUSTOM_TOKEN:longSecret}), '***')
  assert.equal(safeErrorMessage(new Error('x'.repeat(3000)), 'Failed', {}).length, 2000)
})

test('polled job failures cannot return provider credentials', () => {
  const job = createJob('privacy-test',new AbortController())
  failJob(job,new Error('Provider rejected Authorization: Bearer private-credential'))
  assert.equal(touchJob(job.id,'privacy-test').error,'Provider rejected Authorization: ***')
  assert.equal(touchJob(job.id,'another-user'),null)
})

test('vault rejects non-hex configuration without exposing it and preserves authenticated encryption', t => {
  const original = process.env.VAULT_ENCRYPTION_KEY
  t.after(() => {if (original === undefined) delete process.env.VAULT_ENCRYPTION_KEY; else process.env.VAULT_ENCRYPTION_KEY=original})
  for (const invalid of ['', 'a'.repeat(63), 'g'.repeat(64), 'ab'.repeat(30)+'zzab']) {
    process.env.VAULT_ENCRYPTION_KEY=invalid
    assert.throws(()=>encrypt('test credential'), /must be exactly 64 hexadecimal characters/)
  }
  process.env.VAULT_ENCRYPTION_KEY='aB'.repeat(32)
  const encrypted=encrypt('test credential')
  assert.equal(decrypt(encrypted),'test credential')
  const ciphertext=Buffer.from(encrypted.ciphertext,'base64')
  ciphertext[0] ^= 1
  assert.throws(()=>decrypt({...encrypted,ciphertext:ciphertext.toString('base64')}))
})
