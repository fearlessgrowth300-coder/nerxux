// Host-side deployment for the agent: start an app under PM2 and put it on a
// subdomain (DNS record + Caddy site). These run OUTSIDE the sandbox, on the
// VPS itself, so every input is validated first and the Nexus server, its
// folder and its port are off limits. Commands are passed as argument arrays,
// never through a shell.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const CADDY_SITES_DIR = '/etc/caddy/sites'
const PROTECTED_NAMES = new Set(['nexus-server'])
const PROTECTED_PORTS = new Set([4000, 11434, 11435, 22, 80, 443])

export function siteDomains(env = process.env) {
  return String(env.NEXUS_SITE_DOMAINS || 'legacynerxux.online').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

export function hostIp(env = process.env) {
  return env.NEXUS_PUBLIC_IP || '2.25.126.125'
}

function defaultExec(cmd, argv, opts = {}) {
  return new Promise((resolve) => execFile(cmd, argv, { timeout: 90000, ...opts }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })))
}

const fail = (msg) => ({ ok: false, exitCode: 1, stdout: '', stderr: msg, durationMs: 0, target: 'host' })

// Roots an app may live under. The Nexus checkout is excluded.
export function validateCwd(cwd, env = process.env) {
  const p = path.posix.normalize(String(cwd || ''))
  if (!p.startsWith('/') || p.includes('\0')) return 'cwd must be an absolute Linux path'
  const roots = String(env.NEXUS_APP_ROOTS || '/root,/srv,/opt,/home').split(',').map((s) => s.trim()).filter(Boolean)
  if (!roots.some((r) => p === r || p.startsWith(r.replace(/\/$/, '') + '/'))) return `cwd must be under ${roots.join(', ')}`
  if (p === '/root/nerxux' || p.startsWith('/root/nerxux/')) return 'the Nexus checkout is not an app you may start'
  return null
}

export function validateService(name) {
  const n = String(name || '').trim()
  if (!NAME_RE.test(n)) return 'service name: letters, digits, dot, dash, underscore, max 64'
  if (PROTECTED_NAMES.has(n)) return 'the Nexus server is never managed from a chat'
  return null
}

// deploy_service: pm2 start, in the app's folder, as `bash -c "<command>"` -
// the same shape every app on this host already uses.
export async function deployService({ name, command, cwd, env: appEnv = {} } = {}, { exec = defaultExec, env = process.env, fsImpl = fs } = {}) {
  const start = Date.now()
  const nameError = validateService(name); if (nameError) return fail(`deploy_service: ${nameError}`)
  const cmd = String(command || '').trim()
  const CTRL = [String.fromCharCode(13), String.fromCharCode(10), String.fromCharCode(0)]
  if (!cmd || cmd.length > 500 || CTRL.some((c) => cmd.includes(c))) return fail('deploy_service: command must be one line, at most 500 characters')
  const cwdError = validateCwd(cwd, env); if (cwdError) return fail(`deploy_service: ${cwdError}`)
  if (appEnv && typeof appEnv === 'object') {
    for (const [k, v] of Object.entries(appEnv)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || typeof v !== 'string' || v.length > 2000) return fail(`deploy_service: bad env entry ${k}`)
    }
  }
  const dir = path.posix.normalize(cwd)
  try { if (!(await fsImpl.stat(dir)).isDirectory()) return fail(`deploy_service: ${dir} is not a directory`) } catch { return fail(`deploy_service: ${dir} does not exist`) }
  // Replace an existing service of the same name so redeploys are idempotent.
  await exec('pm2', ['delete', String(name).trim()])
  const childEnv = { ...process.env, ...(appEnv || {}) }
  const r = await exec('pm2', ['start', 'bash', '--name', String(name).trim(), '--cwd', dir, '--', '-c', cmd], { env: childEnv })
  if (r.code !== 0) return { ok: false, exitCode: r.code, stdout: r.stdout.slice(-2000), stderr: `deploy_service: pm2 start failed\n${r.stderr.slice(-2000)}`, durationMs: Date.now() - start, target: 'host' }
  await exec('pm2', ['save'])
  await new Promise((res) => setTimeout(res, 2500))
  const status = await exec('pm2', ['jlist'])
  let summary = ''
  try {
    const p = JSON.parse(status.stdout || '[]').find((x) => x.name === String(name).trim())
    if (p) summary = `${name}: ${p.pm2_env?.status}, restarts=${p.pm2_env?.restart_time}, pid=${p.pid}`
    if (p && p.pm2_env?.status !== 'online') return { ok: false, exitCode: 1, stdout: summary, stderr: `deploy_service: the process is ${p.pm2_env?.status} right after starting. Run the same command in the foreground in the sandbox first and fix what it prints.`, durationMs: Date.now() - start, target: 'host' }
  } catch { /* best effort */ }
  return { ok: true, exitCode: 0, stdout: `started under PM2 in ${dir}: ${cmd}\n${summary}`, stderr: '', durationMs: Date.now() - start, target: 'host' }
}

