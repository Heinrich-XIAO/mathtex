import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix picks up non-VITE_ vars too (server-side only)
  const env = loadEnv(mode, process.cwd(), '')
  const proxyConfig = {
    // Same-origin tunnel to the Hack Club AI proxy — the proxy does not send
    // CORS headers, so browser calls are proxied here. The API key is added
    // server-side and never reaches the browser bundle.
    '/api': {
      target: 'https://ai.hackclub.com/proxy/v1',
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
    preview: { proxy: proxyConfig },
  }
})