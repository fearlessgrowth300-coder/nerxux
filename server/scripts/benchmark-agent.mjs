// Opt-in real-model smoke test; does not use any user's project or API keys.
// Run on the Linux VPS from server/: node scripts/benchmark-agent.mjs
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { run } from '../adapters/ollama.js'
import { executeInSandbox } from '../lib/sandbox.js'
import { redactSecrets } from '../lib/redact.js'

const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-model-eval-'))
const sessionId = 'model-eval-' + randomUUID()
process.env.NEXUS_AGENT_STATE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-model-eval-state-'))
await fs.writeFile(path.join(projectPath, 'inventory.py'), 'def summarise(records):\n    raise NotImplementedError("Implement the documented contract")\n')
const model = process.env.NEXUS_EVAL_MODEL || 'orcarouter/Qwen3.8-27B-Uncensored:latest'
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 20 * 60 * 1000)
const started = Date.now()
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const start = Date.now()
  const response = await originalFetch(url, init)
  if (String(url).endsWith('/api/chat')) {
    const data = await response.clone().json().catch(() => ({}))
    console.log(JSON.stringify({ event: 'model_round', elapsedSeconds: Math.round((Date.now()-start)/1000), status: response.status, promptTokens: data.prompt_eval_count, outputTokens: data.eval_count, stop: data.done_reason }))
  }
  return response
}
console.log(JSON.stringify({ event: 'started', model, projectPath, sessionId }))
let result, error
try {
  result = await run({ model, projectPath, sessionId, signal: controller.signal,
    prompt: 'Implement inventory.py summarise(records) in the existing local fixture. records is a list of dictionaries, each with sku (a nonempty string) and quantity (a nonnegative integer; booleans are invalid). Return a list of dictionaries with sku and quantity, combining duplicate exact case-sensitive SKUs and sorting by sku. Preserve zero totals. Do not mutate the input. Raise ValueError for a missing field, empty sku, wrong sku type, negative quantity, bool quantity or noninteger quantity. Empty input returns []. Inspect the stub, implement it, write and run meaningful tests with verify_work, then report the result. Work only in this mounted local fixture. No network, deployment, other repositories or pod required. Keep tool calls and explanations short.',
    onProgress: e => { if (e.type === 'tool') console.log(JSON.stringify({ event: 'tool', tool: e.tool, ok: e.ok, exitCode: e.exitCode, elapsedSeconds: Math.round((Date.now() - started) / 1000) })) },
  })
} catch (e) { error = redactSecrets(e.message) }
finally { clearTimeout(timer); globalThis.fetch = originalFetch }

// Independent acceptance cases are supplied through the read-only harness
// after the agent finishes; they never appear in its writable project.
const verification = await executeInSandbox({ sessionId, projectPath, language: 'python', code: `import sys, copy, json
sys.path.insert(0, '.')
from inventory import summarise
count=0
def check(value, expected):
    global count
    original=copy.deepcopy(value)
    assert summarise(value)==expected
    assert value==original
    count+=1
check([], [])
check([{'sku':'z','quantity':0},{'sku':'a','quantity':2},{'sku':'a','quantity':3}], [{'sku':'a','quantity':5},{'sku':'z','quantity':0}])
check([{'sku':'a','quantity':1},{'sku':'A','quantity':4}], [{'sku':'A','quantity':4},{'sku':'a','quantity':1}])
for bad in [{}, {'sku':'x'}, {'quantity':2}, {'sku':'','quantity':1}, {'sku':3,'quantity':1}, {'sku':'x','quantity':-1}, {'sku':'x','quantity':True}, {'sku':'x','quantity':1.5}, {'sku':'x','quantity':'2'}]:
    try: summarise([bad])
    except ValueError: count+=1
    else: raise AssertionError('Invalid input accepted: '+repr(bad))
print(json.dumps({'independentChecksPassed':count}))
` })
const report = { model, projectPath, sessionId, elapsedSeconds: Math.round((Date.now()-started)/1000), toolCount: result?.toolSteps?.length || 0, failedToolCount: result?.toolSteps?.filter(s => !s.ok).length || 0, error, independentPassed: verification.ok, independentStdout: verification.stdout, independentStderr: verification.stderr, modelReport: result?.content }
await fs.writeFile(path.join(projectPath, 'benchmark-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ event: 'finished', ...report }))
process.exitCode = verification.ok && !error ? 0 : 1
