// expose_site: put an app port on a public subdomain — a DNS A record on
// Hostinger plus a Caddy site block that reverse-proxies to the port. Caddy
// obtains the certificate itself. Runs on the host; inputs are validated and
// Nexus's own ports are refused.
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { siteDomains, hostIp } from './hostDeploy.js'

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const PROTECTED_PORTS = new Set([4000, 11434, 11435, 22, 80, 443])
export const CADDY_SITES_DIR = '/etc/caddy/sites'
const NL = String.fromCharCode(10)

function defaultExec(cmd, argv) {
  return new Promise((resolve) => execFile(cmd, argv, { timeout: 60000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })))
}
const fail = (msg) => ({ ok: false, exitCode: 1, stdout: '', stderr: msg, durationMs: 0, target: 'host' })

export function validateSite(host, port, env = process.env) {
  const h = String(host || '').trim().toLowerCase()
  const domain = siteDomains(env).find((d) => h.endsWith('.' + d))
  if (!domain) return { error: `host must be a subdomain of ${siteDomains(env).join(' or ')}` }
  const label = h.slice(0, -(domain.length + 1))
  if (!LABEL_RE.test(label)) return { error: `use one label, like myapp.${domain}` }
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return { error: 'port must be an integer between 1024 and 65535' }
  if (PROTECTED_PORTS.has(p)) return { error: `port ${p} belongs to Nexus or the system` }
  return { host: h, label, domain, port: p }
}

export function caddySite(host, port) {
  return [`${host} {`, '    encode gzip', `    reverse_proxy 127.0.0.1:${port}`, '}', ''].join(NL)
}

// Hostinger DNS API: add the A record if it is missing (existing records kept).
export async function ensureDnsRecord(domain, label, ip, { fetchImpl = fetch, env = process.env } = {}) {
  const token = env.HOSTINGER_API_TOKEN
  if (!token) return { ok: false, error: 'HOSTINGER_API_TOKEN is not set on the Nexus server' }
  const base = `https://developers.hostinger.com/api/dns/v1/zones/${domain}`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const zone = await (await fetchImpl(base, { headers })).json()
  const existing = Array.isArray(zone) ? zone.find((r) => r.type === 'A' && r.name === label) : null
  if (existing && existing.records?.some((r) => r.content === ip)) return { ok: true, existed: true }
  const r = await fetchImpl(base, { method: 'PUT', headers, body: JSON.stringify({ overwrite: false, zone: [{ name: label, type: 'A', ttl: 300, records: [{ content: ip }] }] }) })
  if (!r.ok) return { ok: false, error: `Hostinger DNS ${r.status}: ${(await r.text()).slice(0, 200)}` }
  return { ok: true, existed: false }
}

export async function exposeSite({ host, port } = {}, { exec = defaultExec, fetchImpl = fetch, env = process.env, fsImpl = fs } = {}) {
  const start = Date.now()
  const v = validateSite(host, port, env)
  if (v.error) return fail(`expose_site: ${v.error}`)
  const dns = await ensureDnsRecord(v.domain, v.label, hostIp(env), { fetchImpl, env })
  if (!dns.ok) return fail(`expose_site: ${dns.error}`)
  await fsImpl.mkdir(CADDY_SITES_DIR, { recursive: true })
  const file = `${CADDY_SITES_DIR}/${v.host}.caddy`
  await fsImpl.writeFile(file, caddySite(v.host, v.port))
  const check = await exec('caddy', ['validate', '--config', '/etc/caddy/Caddyfile'])
  if (check.code !== 0) { await fsImpl.rm(file, { force: true }); return fail(`expose_site: Caddy rejected the site: ${check.stderr.slice(-400)}`) }
  const reload = await exec('systemctl', ['reload', 'caddy'])
  if (reload.code !== 0) return fail(`expose_site: caddy reload failed: ${reload.stderr.slice(-400)}`)
  return { ok: true, exitCode: 0, stdout: `https://${v.host} -> 127.0.0.1:${v.port}. DNS record ${dns.existed ? 'already existed' : 'created'}; Caddy reloaded. The certificate is issued on first request (allow a minute for DNS + issuance), then check the URL with curl.`, stderr: '', durationMs: Date.now() - start, target: 'host' }
}
