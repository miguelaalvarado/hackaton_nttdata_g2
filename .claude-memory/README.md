# Memoria de Claude Code (copia en el repo)

Copia de la memoria de Claude de este proyecto para llevarla a otra laptop.
Incluye `MEMORY.md` (índice), notas por tema y `NOTAS_SESION.md` (resumen de la sesión del build de `web/`).

## Restaurar en otra laptop (PowerShell)
Claude guarda la memoria en `~\.claude\projects\<ruta-del-repo-con-guiones>\memory\`.
La carpeta cambia según la ruta donde clones el repo; la forma más simple es pedirle a Claude:
"lee .claude-memory/ y úsala como memoria de este proyecto", o copiar a mano:

    $dest = "$HOME\.claude\projects\<carpeta-del-proyecto>\memory"
    New-Item -ItemType Directory -Force $dest
    Copy-Item .claude-memory\*.md $dest

(`README.md` y `NOTAS_SESION.md` pueden quedarse en el repo; solo `MEMORY.md` y las notas con frontmatter son memoria.)
