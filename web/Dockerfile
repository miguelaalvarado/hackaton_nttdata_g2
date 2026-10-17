# syntax=docker/dockerfile:1
# (node:20-slim = glibc: el binario nativo de libSQL no tiene build para Alpine/musl en el lock)
# Imagen mínima de Next.js (output "standalone"). Funciona en cualquier nube con contenedores.
#   docker build -t cobrador-web ./web
#   docker run -p 3000:3000 -v cobrador-data:/app/data -e OPENROUTER_API_KEY=... cobrador-web

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd -r app && useradd -r -g app app && mkdir -p /app/data && chown app:app /app/data
# SQLite (libSQL) en un volumen: docker run -v cobrador-data:/app/data ...
ENV DB_URL=file:/app/data/cobranza.db
VOLUME ["/app/data"]
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
