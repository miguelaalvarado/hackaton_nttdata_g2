# Imagen única del monorepo. Objetivos: app (api/worker/migrate) y web.
# node:22-bookworm ya incluye OpenSSL (lo requiere Prisma); no hace falta apt-get.
FROM node:22-bookworm AS base
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/messaging/package.json packages/messaging/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

FROM base AS app
ENV NODE_ENV=production
CMD ["npm", "run", "start", "-w", "@acompana/api"]

FROM base AS web-build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @acompana/web

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
