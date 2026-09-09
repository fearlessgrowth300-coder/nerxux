import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'

// Exercise the actual interceptors with Axios's adapter boundary and a fake
// Auth service. No credentials or network requests are used.
const source = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/export /g, '')

function setup({ refreshError, expired = false, rejectEveryRequest = false } = {}) {
  const calls = { refresh: 0, logout: 0, redirect: 0, requests: [] }
  const session = { access_token: 'original', expires_at: Date.now() / 1000 + (expired ? -10 : 3600) }
  const context = {
    axios,
    supabase: { auth: {
      getSession: async () => ({ data: { session } }),
      refreshSession: async () => {
        calls.refresh++
        await new Promise(resolve => setTimeout(resolve, 5))
        return refreshError ? { data: {}, error: refreshError } :
          { data: { session: { access_token: 'refreshed' } } }
      },
      signOut: async () => { calls.logout++ },
    } },
    window: {
      location: { pathname: '/chat', assign: () => { calls.redirect++ } },
      sessionStorage: { setItem() {} },
    },
  }
  vm.createContext(context)
  vm.runInContext(source + '\nthis.client = api', context)
  const client = context.client
  client.defaults.adapter = async config => {
    calls.requests.push({ baseURL: config.baseURL, token: config.headers.Authorization })
    if (rejectEveryRequest || config.headers.Authorization === 'Bearer original') {
      throw new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, null,
        { status: 401, data: { error: 'Invalid or expired session. Please log in again.' }, config })
    }
    return { status: 200, data: { ok: true }, headers: {}, config }
  }
  return { client, calls }
}

test('uses the current origin and keeps the refreshed token on retry', async () => {
  const { client, calls } = setup()
  assert.equal((await client.get('/api/compute/status')).status, 200)
  assert.deepEqual(calls.requests, [
    { baseURL: '', token: 'Bearer original' },
    { baseURL: '', token: 'Bearer refreshed' },
  ])
  assert.equal(calls.refresh, 1)
  assert.equal(calls.logout, 0)
})

test('concurrent expired requests share a refresh', async () => {
  const { client, calls } = setup({ expired: true })
  await Promise.all([client.get('/api/compute/status'), client.get('/api/connections')])
  assert.equal(calls.refresh, 1)
  assert.equal(calls.logout, 0)
})

test('a backend rejection after refresh does not log the user out', async () => {
  const { client, calls } = setup({ rejectEveryRequest: true })
  await assert.rejects(client.get('/api/compute/status'))
  assert.equal(calls.requests.length, 2)
  assert.equal(calls.logout, 0)
  assert.equal(calls.redirect, 0)
})

test('temporary Auth failures preserve the session and abort the stale request', async () => {
  const { client, calls } = setup({ expired: true,
    refreshError: { name: 'AuthRetryableFetchError', status: 504 } })
  await assert.rejects(client.get('/api/compute/status'))
  assert.equal(calls.logout, 0)
  assert.equal(calls.requests.length, 0)
})

test('confirmed invalid refresh tokens clear the session', async () => {
  const { client, calls } = setup({ expired: true,
    refreshError: { code: 'refresh_token_not_found' } })
  await assert.rejects(client.get('/api/compute/status'))
  assert.equal(calls.logout, 1)
  assert.equal(calls.redirect, 1)
  assert.equal(calls.requests.length, 0)
})
