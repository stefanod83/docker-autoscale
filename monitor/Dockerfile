# ---------- Stage 1: builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Manifest + deps (incluse dev per esbuild). Se manca il lockfile, usa npm install.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Sorgenti server e dashboard
COPY server.js ./server.js
COPY swarm/public ./swarm/public
COPY autoscaler/public ./autoscaler/public
COPY autoscaler/src ./autoscaler/src

# Bundle Autoscaler: genera /autoscaler/public/assets/app.js
RUN npm run build:autoscaler

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Solo deps di produzione per il server. Se manca il lockfile, usa npm install --omit=dev.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copia server + asset finali
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/swarm ./swarm
COPY --from=builder /app/autoscaler/public ./autoscaler/public

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "server.js"]
