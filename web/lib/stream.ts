import type { Ctx } from "./core/orquestador";
import type { EventoStream } from "./core/types";

/** Si se pidió LLM y no hay credenciales, el primer evento del stream lo dice: no se disfraza una ejecución de reglas. */
export async function* conAviso(ctx: Ctx, gen: AsyncGenerator<EventoStream>): AsyncGenerator<EventoStream> {
  if (ctx.degradado) {
    yield { tipo: "evento", evento: { id: 0, de: "supervisor", a: "bd", tipo: "registro", titulo: "Modo LLM no disponible", texto: ctx.degradado, estado: "rechazado", datos: { degradado: true } } };
  }
  yield* gen;
}

/** Convierte un generador de eventos en una respuesta NDJSON (una línea JSON por evento). */
export function ndjson(gen: AsyncGenerator<EventoStream>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of gen) controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      } catch (e) {
        console.error("[stream]", e instanceof Error ? e.stack ?? e.message : e);
        // En producción no se exponen detalles internos al cliente.
        const detalle = process.env.NODE_ENV === "production" ? "Error del agente (ver registros del servidor)" : e instanceof Error ? e.message : "Error del agente";
        controller.enqueue(enc.encode(JSON.stringify({ tipo: "fin", estado: "error", detalle } satisfies EventoStream) + "\n"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
