import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const appSource = fileURLToPath(new URL('../../src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  envDir: repoRoot,
  plugins: [
    react(),
    // A service worker keeps a copy of the app itself (index.html and the built JS/CSS) on the device,
    // so ConnectED still opens when there is no connection. Only the app's own files are kept:
    // GraphQL and Cognito requests are never cached here (data offline is IndexedDB's job, src/offline).
    VitePWA({
      registerType: 'autoUpdate',   // a new deployment replaces the old copy the next time the app is opened
      injectRegister: 'script',     // adds a small registerSW.js to index.html; no app code changes
      manifest: false,              // offline loading only; not an installable app
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html', // any in-app address (e.g. /assessments/…/scores) opens the kept app
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false }, // npm run web stays as it is; test with build + preview
    }),
  ],
  resolve: { alias: { '/src': appSource } },
  server: { port: 5173 },
  // @gradebook/domain (backend/library) is linked as a workspace and is plain
  // ES modules with no dependencies, so Vite serves it as source. Do not add it
  // to optimizeDeps.include: Vite would then keep a pre-bundled copy in
  // node_modules/.vite that it never refreshes when the library changes, and a
  // page importing a newly added export would fail to load (blank screen).
});
