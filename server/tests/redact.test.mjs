import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../lib/redact.js'

// This is the real output that put a live GitHub token into the transcript:
// the model ran `env` while orienting itself.
const ENV_DUMP = `GIT_COMMITTER_NAME=Nexus AI
GITHUB_TOKEN=ghp_EXAMPLEfake000000000000000000000000
GIT_CONFIG_KEY_0=url.https://x-access-token:ghp_EXAMPLEfake000000000000000000000000@github.com/.insteadOf
USER=root`

test('a token printed by env does not reach the transcript', () => {
  const out = redactSecrets(ENV_DUMP)
  assert.doesNotMatch(out, /ghp_EXAMPLEfake000000000000000000000000/)
  assert.match(out, /GITHUB_TOKEN=ghp_\*\*\*/)
  assert.match(out, /USER=root/, 'ordinary output must survive intact')
})

test('the same token embedded in a git URL is caught too', () => {
  const out = redactSecrets('remote: https://x-access-token:ghp_AAAAAAAAAAAAAAAAAAAAAAAA@github.com/me/repo.git')
  assert.doesNotMatch(out, /ghp_AAAAAAAAAAAAAAAAAAAAAAAA/)
})

test('the other providers in use here are covered', () => {
  const s = redactSecrets([
    'vcp_EXAMPLEfake0000000000000000000000',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'gsk_abcdefghijklmnopqrstuvwxyz0123',
    'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
    'BSAWp3ZTHYgLW5TJcGlt-VsUZagfpl1xx',
    'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijklmnop',
  ].join('\n'))
  for (const leaked of ['vcp_1nL', 'sk-ant-api03-abc', 'gsk_abc', 'AIzaSyA123', 'BSAWp3ZTHY', 'eyJyb2xl']) {
    assert.ok(!s.includes(leaked), `leaked: ${leaked}`)
  }
})

test('an exact known secret is removed even if it matches no pattern', () => {
  const out = redactSecrets('token is my-weird-custom-secret-value', ['my-weird-custom-secret-value'])
  assert.equal(out, 'token is ***')
})

test('normal output is left alone', () => {
  const text = 'total 12\ndrwxr-xr-x 3 root root 4096 Sep 10 19:20 .\nnode v22.23.2\nhttps://github.com/me/repo.git'
  assert.equal(redactSecrets(text), text)
})
