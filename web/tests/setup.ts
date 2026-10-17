import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Base TEMPORAL por proceso de prueba: nunca se toca ./data/cobranza.db. Sin credenciales ni token de administración.
process.env.DB_URL = `file:${join(mkdtempSync(join(tmpdir(), "nexo-test-")), "t.db")}`;
for (const k of ["OPENROUTER_API_KEY", "AGENTS", "NEXO_ADMIN_TOKEN"]) delete process.env[k];
