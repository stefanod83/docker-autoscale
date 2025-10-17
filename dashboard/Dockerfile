# ---------- deps + build frontend ----------
FROM node:18-alpine AS deps
WORKDIR /app

# Usa lockfile se presente, altrimenti fallback a install
COPY package*.json ./
# Se hai package-lock.json, npm ci è deterministico; senza, usa npm install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build
WORKDIR /app
# sorgenti UI
COPY ./src ./src
COPY ./public ./public
# dipendenze UI extra per build (se non già in package.json)
RUN npm install @mui/material @emotion/react @emotion/styled --no-save
# build static
RUN npm run build

# ---------- runtime minimale con solo server ----------
FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# puntamento a dsproxy_ro e API Engine
ENV DOCKER_API_URL=http://dsproxy_ro:2375
ENV DOCKER_API_VERSION=v1.51

# package.json minimale per il server ESM
RUN node -e "const fs=require('fs'); \
const pkg={name:'dashboard-server',version:'1.0.0',private:true,type:'module',dependencies:{express:'^4.19.2'}}; \
fs.writeFileSync('package.json', JSON.stringify(pkg));"

# Qui non c'è lockfile: usa npm install con omit=dev (non npm ci)
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# copia artefatti statici e server dalla tua sorgente
COPY --from=build /app/build ./build
COPY ./src/server.js ./server.js

# utente non-root
RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp
USER nodeapp

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT, r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node","/app/server.js"]
