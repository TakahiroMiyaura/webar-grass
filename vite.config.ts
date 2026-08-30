import {defineConfig} from 'vite'
import fs from 'node:fs'
import {ensureCert, lanAddresses} from './scripts/dev-cert.mjs'

// HTTPS=0 serves plain HTTP. That is the mode to use behind a tunnel (cloudflared /
// ngrok), which terminates TLS with a real certificate - the route that works on iOS,
// where Safari will not hand the camera to an origin with an untrusted certificate.
const useHttps = process.env.HTTPS !== '0'
const https = useHttps
  ? (() => {
    const {key, cert} = ensureCert()
    return {key: fs.readFileSync(key), cert: fs.readFileSync(cert)}
  })()
  : undefined

export default defineConfig({
  // Relative asset URLs, so the same build works at the domain root and at the
  // /<repo>/ subpath GitHub Pages serves a project site from.
  base: './',
  build: {
    // iOS Safari 15 is the realistic floor for the engine.
    target: ['es2020', 'safari15'],
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        // The tracking-ux state machine harness. Built so scripts/verify-tracking-ux.mjs
        // can drive the same bundle that ships; the deploy workflow deletes it from
        // dist/ before upload so it is never published.
        statemachine: 'statemachine-test.html',
      },
    },
  },
  server: {
    // Listen on the LAN so a phone on the same Wi-Fi can reach the dev server.
    host: true,
    port: 5173,
    https,
    // A tunnel presents its own hostname; without this Vite rejects the request.
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 4173,
    https,
    allowedHosts: true,
  },
  plugins: [
    {
      name: 'print-lan-urls',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          const port = (server.httpServer?.address() as {port: number}).port
          const scheme = useHttps ? 'https' : 'http'
          for (const ip of lanAddresses()) {
            console.log(`  \x1b[32m➜\x1b[0m  Phone:   ${scheme}://${ip}:${port}/`)
          }
        })
      },
    },
  ],
})
