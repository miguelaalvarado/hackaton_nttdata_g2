import type { EventoStream } from "./core/types";

/** Convierte un generador de eventos en una respuesta NDJSON (una línea JSON por evento). */
export function ndjson(gen: AsyncGenerator<EventoStream>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of gen) controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      } catch (e) {
        const detalle = e instanceof Error ? e.message : "Error del agente";
        console.error("[stream]", detalle);
        controller.enqueue(enc.encode(JSON.stringify({ tipo: "fin", estado: "error", detalle } satisfies EventoStream) + "\n"));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
