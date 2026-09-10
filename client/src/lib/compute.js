import { api } from './api'

// Compute Mode API Client
export async function getComputeStatus() {
  const { data } = await api.get('/api/compute/status')
  return data
}

export async function switchComputeMode(mode, stopPod = false) {
  const { data } = await api.post('/api/compute/switch', { mode, stopPod })
  return data
}

export async function setHostingerIp(ip) {
  const { data } = await api.post('/api/compute/hostinger', { ip })
  return data
}

export async function startPod() {
  const { data } = await api.post('/api/compute/pod/start')
  return data
}

export async function stopPod() {
  const { data } = await api.post('/api/compute/pod/stop')
  return data
}

export async function getPodDetails() {
  const { data } = await api.get('/api/compute/pod')
  return data
}

export async function listPods() {
  const { data } = await api.get('/api/compute/pods')
  return data.pods || []
}

export async function selectPod(podId) {
  const { data } = await api.post('/api/compute/pod', { podId })
  return data
}
