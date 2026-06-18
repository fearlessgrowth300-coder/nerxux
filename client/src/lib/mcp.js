import { api, apiError } from './api'

// Client for MCP connectors (custom Model Context Protocol servers).

export async function getConnectors() {
  try {
    const { data } = await api.get('/api/mcp')
    return data.connectors
  } catch (err) {
    throw apiError(err, 'Failed to load connectors')
  }
}

export async function addConnector({ name, url, oauthClientId, oauthSecret }) {
  try {
    const { data } = await api.post('/api/mcp', { name, url, oauthClientId, oauthSecret })
    return data.connector
  } catch (err) {
    throw apiError(err, 'Failed to add connector')
  }
}

// Starts the OAuth flow. Returns { authUrl } to open in a popup, or
// { authorized: true } if the connector already has valid tokens.
export async function authorizeConnector(id) {
  try {
    const { data } = await api.post(`/api/mcp/${id}/authorize`)
    return data
  } catch (err) {
    throw apiError(err, 'Failed to start authorization')
  }
}

export async function refreshConnector(id) {
  try {
    const { data } = await api.post(`/api/mcp/${id}/refresh`)
    return data.connector
  } catch (err) {
    throw apiError(err, 'Failed to refresh connector')
  }
}

export async function setConnectorEnabled(id, enabled) {
  try {
    const { data } = await api.patch(`/api/mcp/${id}`, { enabled })
    return data.connector
  } catch (err) {
    throw apiError(err, 'Failed to update connector')
  }
}

export async function removeConnector(id) {
  try {
    await api.delete(`/api/mcp/${id}`)
  } catch (err) {
    throw apiError(err, 'Failed to remove connector')
  }
}
