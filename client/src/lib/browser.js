import { api } from './api'

// The host browser the agent drives. The user takes it over through these —
// same browser, same cookies, so a login done here is a login the agent has.
export async function getBrowserState() {
  const { data } = await api.get('/api/browser/state')
  return data
}

export async function startBrowser() {
  const { data } = await api.post('/api/browser/start')
  return data
}

export async function navigateBrowser(url) {
  const { data } = await api.post('/api/browser/navigate', { url })
  return data
}

// click {x,y} · text {text} · key {key} · scroll {deltaY}
export async function sendBrowserInput(input) {
  const { data } = await api.post('/api/browser/input', input)
  return data
}

export async function stopBrowser() {
  const { data } = await api.post('/api/browser/stop')
  return data
}

// Fetched as a blob rather than pointed at with <img src>: the frame endpoint
// needs the bearer token, and an <img> cannot send one. The caller revokes the
// previous object URL — without that, a 2 fps poll leaks a JPEG per frame.
export async function fetchFrame() {
  const { data } = await api.get('/api/browser/frame', { responseType: 'blob' })
  return URL.createObjectURL(data)
}
