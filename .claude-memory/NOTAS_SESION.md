# Notas de sesión — build de `web/` (Next.js)

Rama: `phase2`. Fecha: 2026-10-17.

## Problema
`npm run build` en `web/` fallaba con:

```
ENOENT: no such file or directory, open '...\web\.next\server\pages\_app.js.nft.json'
```

## Causa
Había `next dev -p 3141` y `npm run start` corriendo a la vez, escribiendo en la misma carpeta `.next`.
Síntoma extra: `rm -rf .next` fallaba con "Directory not empty". El proyecto solo usa `app/` (no `pages/`), así que ese archivo no debía hacer falta.

## Solución
1. Cerrar `next dev` / `next start` (procesos `node.exe` con "next" en la línea de comandos; no tocar los node de MCP).
2. Limpiar y construir:
   ```powershell
   Remove-Item -Recurse -Force .next; npm run build
   ```
3. En `web/next.config.mjs` se añadió `outputFileTracingRoot: import.meta.dirname` para silenciar el aviso de "multiple lockfiles" (hay un `package-lock.json` suelto en `C:\Users\miguel.alvarado\`).

## Estado al cerrar
- Build limpio OK, sin avisos; todos los procesos de Next cerrados.
- Cambios sin commitear: `web/next.config.mjs`, `src/gen_cartera.py`, `web/seed/cartera.json`, `web/seed/modelo.json`.
- Pendiente: decidir/commitear esos cambios. El build no se probó con el servidor corriendo después de cerrar todo.

## Regla práctica
Antes de `npm run build`, no tener `next dev` ni `next start` activos sobre el mismo `.next`.
