import { api, apiError } from './api'

export async function getNative() {
  try {
    const { data } = await api.get('/api/native')
    return data.connectors
  } catch (err) {
    throw apiError(err, 'Failed to load integrations')
  }
}

export async function getNativeCallbackUrl() {
  try {
    const { data } = await api.get('/api/native/callback-url')
    return data.callbackUrl
  } catch {
    return null
  }
}

export async function connectNative(provider, { clientId, clientSecret }) {
  try {
    const { data } = await api.post(`/api/native/${provider}/connect`, { clientId, clientSecret })
    return data.authUrl
  } catch (err) {
    throw apiError(err, 'Failed to start connection')
  }
}

export async function disconnectNative(provider) {
  try {
    await api.delete(`/api/native/${provider}`)
  } catch (err) {
    throw apiError(err, 'Failed to disconnect')
  }
}
