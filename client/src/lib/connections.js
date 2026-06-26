import { api, apiError } from './api'

// Client for the server-side API vault. Note: keys are write-only from the
// client's perspective — the server never returns the plaintext key, only
// connected status + last4.

export async function getConnections() {
  try {
    const { data } = await api.get('/api/connections')
    return data.connections
  } catch (err) {
    throw apiError(err, 'Failed to load connections')
  }
}

// Paste any key — the server detects the provider. Pass `provider` to override
// when detection fails (the thrown error carries `.needsProvider` in that case).
export async function addConnection(apiKey, provider) {
  try {
    const { data } = await api.post('/api/connections', {
      apiKey,
      ...(provider ? { provider } : {}),
    })
    return data.connection
  } catch (err) {
    const e = apiError(err, 'Failed to add key')
    e.needsProvider = Boolean(err?.response?.data?.needsProvider)
    throw e
  }
}

export async function saveConnection(provider, apiKey) {
  try {
    const { data } = await api.put(`/api/connections/${provider}`, { apiKey })
    return data.connection
  } catch (err) {
    throw apiError(err, 'Failed to save key')
  }
}

export async function removeConnection(provider) {
  try {
    await api.delete(`/api/connections/${provider}`)
  } catch (err) {
    throw apiError(err, 'Failed to disconnect')
  }
}
