import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
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
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icons.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'MathTex — voice math dictation',
          short_name: 'MathTex',
          description: 'Dictate math by voice and get LaTeX.',
          lang: 'en',
          start_url: '/',
          display: 'standalone',
          theme_color: '#0e1116',
          background_color: '#0e1116',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // App shell: precache built assets (JS/CSS/HTML/fonts/icons).
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          navigateFallback: '/index.html',
          // ONNX runtime + VAD model are big (14M+2.3M): cache at runtime
          // instead of precaching, so first install stays light.
          runtimeCaching: [
            {
              urlPattern: /\/(ort|vad)\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'model-assets',
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
            },
          ],
        },
      }),
    ],
    server: { proxy: proxyConfig },
    preview: { proxy: proxyConfig, https: httpsCerts },
  }
})