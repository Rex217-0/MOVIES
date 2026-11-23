# Movie Creator server - the render backend the APK talks to.
#
# Node 24 runs server.ts directly (type stripping is built in), so there is no
# compile step for the server itself. The web UI still needs a Vite build.
FROM node:24-bookworm-slim

# ffmpeg comes from the @ffmpeg-installer/ffmpeg package, but drawtext needs a
# real font file on disk, and the bundled binary wants libstdc++/libgcc.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-dejavu-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not reinstall node_modules.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The UI is built here, not committed: dist/ is gitignored.
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# / is served by the built UI and needs no token, so it is a real readiness
# signal; every /api route requires APP_AUTH_TOKEN and would report 401.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.ts"]
