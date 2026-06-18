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
