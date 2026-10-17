---
name: next-build-enoent-dev-server
description: web/ Next.js build fails with ENOENT on .next/server/pages/_app.js.nft.json when next dev/start is running; fix and state of next.config.mjs
metadata:
  node_type: memory
  type: project
  originSessionId: 96c8ac21-01cc-4720-9df3-869b286fefdc
  modified: 2026-10-17T21:20:46.840Z
---

En `web/` (Next 15.5, solo `app/`), `npm run build` falló con `ENOENT ... .next\server\pages\_app.js.nft.json` porque había `next dev -p 3141` y `npm run start` corriendo y escribiendo en el mismo `.next`.

**Why:** dos procesos de Next compartiendo `.next` corrompen el build (también hace que `rm -rf .next` falle con "Directory not empty").

**How to apply:** antes de `npm run build`, cerrar `next dev`/`next start` (buscar node.exe con "next" en la línea de comandos; no tocar los node de MCP), luego `Remove-Item -Recurse -Force .next; npm run build`. Estado al cerrar la sesión: build limpio OK, procesos de Next cerrados, y se añadió `outputFileTracingRoot: import.meta.dirname` en `web/next.config.mjs` para silenciar el aviso del `package-lock.json` suelto en `C:\Users\miguel.alvarado\` (cambio sin commitear, junto con `src/gen_cartera.py`, `web/seed/cartera.json`, `web/seed/modelo.json` en la rama `phase2`).
