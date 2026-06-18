import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Vite config for the Nexus AI client.
// The dev server proxies /api calls to the Express backend so we avoid
// CORS issues during local development. The `@shared` alias lets the client
// import the shared model registry that also powers the server.
const sharedDir = fileURLToPath(new URL('../shared', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': sharedDir,
    },
  },
  server: {
    port: 5173,
    // Allow serving files from the monorepo's shared folder (outside client root).
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
