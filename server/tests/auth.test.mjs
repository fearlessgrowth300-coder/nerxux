import { test } from 'node:test'
import assert from 'node:assert'
import { supabaseAdmin } from '../lib/supabase.js'
import { requireAuth } from '../lib/auth.js'

function call(token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = { status(c) { return { json: (b) => resolve({ code: c, body: b }) } } }
    requireAuth(req, res, () => resolve({ code: 'next', user: req.user }))
  })
}

test('auth: network failure is retryable, bad token is 401, good token is cached', async () => {
  let calls = 0
  supabaseAdmin.auth.getUser = async (t) => {
    calls++
    if (t === 'down') return { data: null, error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError', status: 0 }) }
    if (t === 'bad') return { data: null, error: Object.assign(new Error('invalid JWT'), { name: 'AuthApiError', status: 403 }) }
    return { data: { user: { id: 'u1' } }, error: null }
  }
  assert.equal((await call('down')).code, 503)
  assert.equal((await call('bad')).code, 401)
  assert.equal((await call('good')).code, 'next')
  const before = calls
  assert.equal((await call('good')).user.id, 'u1')
  assert.equal(calls, before, 'second request served from cache')
})
