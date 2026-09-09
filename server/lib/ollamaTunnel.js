import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const TURBO_URL = 'http://127.0.0.1:11435'
export const TURBO_MODEL = 'orcarouter/Qwen3.8-27B-Uncensored:latest'

// Both the executable and models live on the pod's persistent /workspace disk.
export const START_OLLAMA = [
  'set -eu',
  'if curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then exit 0; fi',
  'if [ ! -x /workspace/nerxux-ollama/bin/ollama ]; then echo "Persistent Ollama installation is missing on RunPod" >&2; exit 42; fi',
  'nohup env OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=/workspace/nerxux-ollama/models /workspace/nerxux-ollama/bin/ollama serve >/workspace/nerxux-ollama/ollama.log 2>&1 </dev/null &',
].join('\n')

export function podSshEndpoint(pod) {
  if (pod?.status !== 'RUNNING') return null
  const entry = pod.runtime?.ports?.find(p => Number(p.private) === 22 && p.ip && p.public)
  const host = entry?.ip || pod.ssh?.direct?.host
  const port = Number(entry?.public || pod.ssh?.direct?.port)
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

export function checkOllama(url = TURBO_URL, model = TURBO_MODEL) {
  return new Promise(resolve => {
    const req = http.get(url + '/api/tags', { timeout: 2000 }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('error', () => resolve(false))
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          resolve(res.statusCode === 200 && Array.isArray(data.models) &&
            data.models.some(m => m.name === model || m.model === model))
        } catch { resolve(false) }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

export class OllamaTunnel {
  constructor(keyPath, dependencies = {}) {
    this.keyPath = keyPath
    this.run = dependencies.run || run
    this.spawn = dependencies.spawn || spawn
    this.probe = dependencies.probe || checkOllama
    this.sleep = dependencies.sleep || sleep
    this.now = dependencies.now || Date.now
    this.child = null
    this.endpoint = null
    this.ready = false
  }

  async stop() {
    const child = this.child
    this.child = null
    this.endpoint = null
    this.ready = false
    if (!child) return
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }

  async start(host, port) {
    if (this.child && this.endpoint === host + ':' + port && await this.probe()) {
      this.ready = true
      return true
    }
    await this.stop()
    const common = ['-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', this.keyPath]
    let lastError = ''
    let started = false
    const start = this.now()
    while (this.now() - start < 120000) {
      try {
        await this.run('ssh', [...common, 'root@' + host, START_OLLAMA], { timeout: 15000, windowsHide: true })
        started = true
        break
      } catch (err) {
        lastError = (err.stderr || err.message || '').trim().slice(-500)
        if (err.code === 42 || /Permission denied|Host key verification failed/.test(lastError)) {
          throw new Error('RunPod startup failed: ' + lastError)
        }
        await this.sleep(2000)
      }
    }
    if (!started) throw new Error('RunPod SSH is not ready: ' + lastError)

    const child = this.spawn('ssh', [...common, '-N', '-L', '127.0.0.1:11435:127.0.0.1:11434',
      '-o', 'ExitOnForwardFailure=yes', 'root@' + host], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    this.endpoint = host + ':' + port
    let failure = ''
    child.stderr?.on('data', data => { failure = (failure + data).slice(-500) })
    const clear = () => {
      if (this.child === child) { this.child = null; this.ready = false; this.endpoint = null }
    }
    child.on('close', clear)
    child.on('error', err => { failure = err.message; clear() })
    const waitStart = this.now()
    while (this.now() - waitStart < 45000 && this.child === child) {
      if (await this.probe() && this.child === child) {
        this.ready = true
        return true
      }
      await this.sleep(1000)
    }
    await this.stop()
    throw new Error(failure.trim() ? 'RunPod tunnel failed: ' + failure.trim() :
      'RunPod Ollama did not load the required model. Check its persistent Ollama log.')
  }

  async health() {
    this.ready = Boolean(this.child) && await this.probe()
    return this.ready
  }
}

