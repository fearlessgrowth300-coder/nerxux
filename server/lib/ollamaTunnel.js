import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const TURBO_URL = 'http://127.0.0.1:11435'
export const TURBO_MODEL = 'orcarouter/Qwen3.8-27B-Uncensored:latest'

// Preferred layout: executable + models on the pod's persistent /workspace
// volume, so they survive a stop/start or a migration to another host (the
// container disk doesn't). Falls back to a system-wide `ollama` with its
// default model dir when the persistent install isn't there yet.
// OLLAMA_KEEP_ALIVE=-1: never unload the model between requests — the whole
// point of the GPU is answering instantly, not re-reading 17GB per question.
export const START_OLLAMA = [
  'set -eu',
  'if curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then exit 0; fi',
  'if [ -x /workspace/nerxux-ollama/bin/ollama ]; then',
  '  nohup env OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=-1 OLLAMA_MODELS=/workspace/nerxux-ollama/models /workspace/nerxux-ollama/bin/ollama serve >/workspace/nerxux-ollama/ollama.log 2>&1 </dev/null &',
  'elif command -v ollama >/dev/null 2>&1; then',
  '  nohup env OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=-1 ollama serve >/tmp/ollama.log 2>&1 </dev/null &',
  'else',
  '  echo "Ollama is not installed on this RunPod pod (neither /workspace/nerxux-ollama nor a system ollama)" >&2; exit 42',
  'fi',
].join('\n')

export const PROVISION_LOG = '/workspace/nerxux-provision.log'
export const PROVISION_PID = '/workspace/nerxux-ollama/.provision.pid'

// A brand new pod has an empty /workspace — no Ollama, no model. Rather than
// making someone paste shell into RunPod's web terminal, the pod installs
// itself on first use, onto the persistent volume so a later stop/start does
// not repeat the download. It runs detached (~17GB outlives any request) and
// logs where the next attempt can read it.
//
// Safe to run on every Turbo press: it starts an install only when one is not
// already running and not already finished. An install that DIED is started
// again rather than reported as eternally "in progress" — that was the failure
// mode that hid a broken download URL behind a reassuring progress message.
//
// $D is expanded by the outer shell (D is set below), which is why the inner
// script needs no escaping. The asset name is asked for by feature test:
// Ollama moved its releases from .tgz to .tar.zst, and pinning either one
// alone means a silent 404 the next time they change it.
export const PROVISION_OLLAMA = [
  'set -eu',
  'D=/workspace/nerxux-ollama',
  'mkdir -p "$D/models"',
  'if [ -f ' + PROVISION_PID + ' ] && kill -0 "$(cat ' + PROVISION_PID + ' 2>/dev/null || echo 0)" 2>/dev/null; then echo RUNNING; exit 0; fi',
  'if grep -q PROVISION_DONE ' + PROVISION_LOG + ' 2>/dev/null; then echo DONE; exit 0; fi',
  'nohup sh -c "',
  '  set -eu',
  '  echo [1/4] making sure zstd is available...',
  '  command -v zstd >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq zstd; } || true',
  '  echo [2/4] downloading Ollama...',
  '  if command -v zstd >/dev/null 2>&1 && curl -fsSLI https://ollama.com/download/ollama-linux-amd64.tar.zst >/dev/null 2>&1; then',
  '    curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | zstd -d | tar -xf - -C $D',
  '  else',
  '    curl -fsSL https://ollama.com/download/ollama-linux-amd64.tgz | tar -xz -C $D',
  '  fi',
  '  test -x $D/bin/ollama',
  '  echo [3/4] starting Ollama...',
  '  OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE=-1 OLLAMA_MODELS=$D/models $D/bin/ollama serve >$D/ollama.log 2>&1 &',
  '  sleep 8',
  '  echo [4/4] pulling ' + TURBO_MODEL + ' - about 17GB, this is the slow part...',
  '  OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=$D/models $D/bin/ollama pull ' + TURBO_MODEL,
  '  echo PROVISION_DONE',
  '" >' + PROVISION_LOG + ' 2>&1 </dev/null &',
  'echo $! > ' + PROVISION_PID,
  'echo STARTED',
].join('\n')

// Reads both the installer's log AND whether its process is still alive, so a
// crashed install is reported as failed instead of looking like slow progress.
export const PROVISION_STATUS = [
  'if [ -f ' + PROVISION_PID + ' ] && kill -0 "$(cat ' + PROVISION_PID + ' 2>/dev/null || echo 0)" 2>/dev/null',
  '  then echo STATE=alive; else echo STATE=dead; fi',
  'tail -n 3 ' + PROVISION_LOG + ' 2>/dev/null || true',
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

  sshCommon(port) {
    return ['-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', this.keyPath]
  }

  // How far along the one-time install is. Reports a DEAD installer as failed
  // rather than as slow progress, so a broken download surfaces instead of
  // showing a hopeful "[1/4]..." forever.
  async provisionProgress(host, port) {
    try {
      const { stdout } = await this.run('ssh', [...this.sshCommon(port), 'root@' + host, PROVISION_STATUS],
        { timeout: 20000, windowsHide: true })
      const text = (stdout || '').trim()
      const alive = text.includes('STATE=alive')
      // Ollama redraws its progress bar in place — carriage returns plus ANSI
      // escapes. Left alone those reach the UI as literal "[?25h" garbage, and
      // the whole redrawn bar arrives as one enormous line.
      const lines = text
        .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('STATE='))
      const line = lines.pop() || ''
      const done = text.includes('PROVISION_DONE')
      return { done, alive, line, failed: !done && !alive && lines.length + (line ? 1 : 0) > 0 }
    } catch (err) {
      return { done: false, alive: false, line: '', failed: false, error: (err.stderr || err.message || '').trim().slice(-200) }
    }
  }

  // Starts (or reports on) the one-time install of Ollama + the model on a new
  // pod. Returns the message to show the user — never a silent success: the
  // download outlives the request by a long way.
  async provision(host, common) {
    let output = ''
    try {
      const { stdout } = await this.run('ssh', [...common, 'root@' + host, PROVISION_OLLAMA],
        { timeout: 30000, windowsHide: true })
      output = (stdout || '').trim()
    } catch (err) {
      return 'This pod has no Ollama installed and the setup could not be started: ' +
        (err.stderr || err.message || '').trim().slice(-300)
    }

    if (output.includes('DONE')) {
      return 'The pod finished installing but Ollama is not answering yet. Press Turbo again in a minute.'
    }
    if (output.includes('RUNNING')) {
      const p = await this.provisionProgress(host, Number(common[common.indexOf('-p') + 1]))
      return 'Setting up your new pod — this takes 10–20 minutes (the model is ~17GB)' +
        (p.line ? '. Latest: ' + p.line : '') + '. Press Turbo again to check.'
    }
    return 'New pod detected — installing Ollama and downloading the 27B model (~17GB) on the pod now. ' +
      'This takes about 10–20 minutes and keeps going even if you close the app. Press Turbo again to check progress.'
  }

  async start(host, port) {
    if (this.child && this.endpoint === host + ':' + port && await this.probe()) {
      this.ready = true
      return true
    }
    await this.stop()
    const common = this.sshCommon(port)
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
        // Nothing installed yet — a fresh pod. Kick off the install and say so,
        // instead of failing with "Ollama is not installed" and leaving the
        // user to work out what to type into RunPod's terminal.
        if (err.code === 42) {
          throw Object.assign(new Error(await this.provision(host, common)), { provisioning: true })
        }
        if (/Permission denied|Host key verification failed/.test(lastError)) {
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

