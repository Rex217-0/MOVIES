import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the Movie Creator Android app.
 *
 * The native shell loads the already-built web app from `dist/` (bundled into
 * the APK), so the phone does not need the Vite dev server. The heavy work
 * still runs on Server-2; the app reaches it through the base URL baked into
 * the bundle at build time — see `VITE_API_BASE_URL` in docs/capacitor-android.md.
 *
 * There is no server address in this file on purpose: it is set by the owner at
 * build time, never committed.
 */
const config: CapacitorConfig = {
  appId: 'com.ljrgroup.moviecity',
  appName: 'Movie Creator',
  webDir: 'dist',
  android: {
    // Server-2 is reached over the LAN by plain HTTP, so the WebView must be
    // allowed to load cleartext. Tighten this to false once the server is HTTPS.
    allowMixedContent: true,
  },
};

export default config;
