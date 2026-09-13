import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Agent } from 'undici'
import { OLLAMA_DISPATCHER } from '../adapters/ollama.js'

// A cold CPU model sends no bytes for minutes. Node's default fetch aborts
// after 300 s of silence before headers; ours must wait.
test('the Ollama dispatcher waits for slow headers that a default-style timeout would abort', async () => {
  const server = http.createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') }, 1200))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/chat`
  try {
    const strict = new Agent({ headersTimeout: 400 })
    await assert.rejects(fetch(url, { dispatcher: strict }), (e) => /HEADERS_TIMEOUT|timeout/i.test(e.cause?.code || e.cause?.message || e.message))
    const r = await fetch(url, { dispatcher: OLLAMA_DISPATCHER })
    assert.equal((await r.json()).ok, true)
  } finally {
    server.close()
  }
})
