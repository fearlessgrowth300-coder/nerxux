import { api, apiError } from './api'

// Upload training source files (PDF/txt/html/epub) to the model's data folder.
export async function uploadTrainingFiles(fileList) {
  const form = new FormData()
  for (const f of fileList) form.append('files', f)
  try {
    const { data } = await api.post('/api/training/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return data
  } catch (e) {
    throw apiError(e, 'Upload failed')
  }
}

export async function deleteTrainingFile(name) {
  try {
    const { data } = await api.delete(`/api/training/upload/${encodeURIComponent(name)}`)
    return data
  } catch (e) {
    throw apiError(e, 'Delete failed')
  }
}

export async function getTrainingStatus() {
  try {
    const { data } = await api.get('/api/training/status')
    return data
  } catch (e) {
    throw apiError(e, 'Status failed')
  }
}

export async function getTrainingLogs() {
  try {
    const { data } = await api.get('/api/training/logs')
    return data
  } catch (e) {
    throw apiError(e, 'Logs failed')
  }
}

export async function buildCorpus() {
  try {
    const { data } = await api.post('/api/training/build')
    return data
  } catch (e) {
    throw apiError(e, 'Build failed')
  }
}

export async function startTraining(opts = {}) {
  try {
    const { data } = await api.post('/api/training/start', opts)
    return data
  } catch (e) {
    throw apiError(e, 'Could not start training')
  }
}

export async function stopTraining() {
  try {
    const { data } = await api.post('/api/training/stop')
    return data
  } catch (e) {
    throw apiError(e, 'Stop failed')
  }
}
