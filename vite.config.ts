import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { existsSync, readFileSync } from 'node:fs'

// Self-signed cert for https (mic requires a secure context off localhost).
// Regenerate with: openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
//   -keyout certs/key.pem -out certs/cert.pem -subj "/CN=mathtex" \
//   -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
const httpsCerts =
  existsSync('certs/key.pem') && existsSync('certs/cert.pem')
    ? { key: readFileSync('certs/key.pem'), cert: readFileSync('certs/cert.pem') }
    : undefined

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix picks up non-VITE_ vars too (server-side only)
  const env = loadEnv(mode, process.cwd(), '')
  const proxyConfig = {
    // Same-origin tunnel so browser calls work without CORS. The OpenRouter
    // key is added server-side and never reaches the browser bundle.
    '/api': {
      target: env.UPSTREAM_BASE_URL || 'https://openrouter.ai/api/v1',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api/, ''),
      ...(env.OPENROUTER_API_KEY
        ? { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }
        : {}),
    },
  }

  return {
    plugins: [react()],
    server: { proxy: proxyConfig },
    preview: { proxy: proxyConfig, https: httpsCerts },
  }
})