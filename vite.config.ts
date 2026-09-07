import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { configureServiceProxy } from './scripts/vite-proxy.mjs'

const servicePort = Number(process.env.QUIZZER_SERVICE_PORT ?? 8787)
if (!Number.isSafeInteger(servicePort) || servicePort < 1 || servicePort > 65535) throw new Error('QUIZZER_SERVICE_PORT must be a valid port')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: ['**/.quizzer-tools/**'],
    },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${servicePort}`,
        configure: proxy => configureServiceProxy(proxy, process.env.QUIZZER_API_TOKEN),
      },
    },
  },
})
