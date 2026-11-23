import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Vite answers 403 to any Host it does not know, which breaks every tunnel
      // URL: Cloudflare quick tunnels rotate on each restart and Tailscale
      // MagicDNS is a *.ts.net name. Allowing every host trades that away for
      // DNS-rebinding exposure, which APP_AUTH_TOKEN covers because the API
      // rejects requests without the bearer token.
      // `as const` keeps the literal type: Vite types this as `true`, and a
      // plain boolean widens and fails `tsc --noEmit`.
      allowedHosts: true as const,
    },
  };
});
