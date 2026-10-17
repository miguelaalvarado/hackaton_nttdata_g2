"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActorId, EventoAgente, EventoStream, Gestion, Turno } from "@/lib/core/types";

type Fin = Extract<EventoStream, { tipo: "fin" }>;
type Cola = { k: "ev"; ev: EventoAgente } | { k: "fin"; fin: Fin };
type Estado = "idle" | "corriendo" | "esperando_humano" | "terminado";

const NODOS: Record<ActorId, { x: number; y: number; nombre: string; rol: string; icono: string }> = {
  analista: { x: 13, y: 20, nombre: "Analista", rol: "Riesgo · estrategia", icono: "📈" },
  supervisor: { x: 50, y: 50, nombre: "Supervisor", rol: "Cumplimiento · seguimiento", icono: "🛡️" },
  gestor: { x: 87, y: 20, nombre: "Gestor", rol: "Conversa · negocia (LLM)", icono: "💬" },
  cliente: { x: 87, y: 82, nombre: "Cliente", rol: "Simulado", icono: "👤" },
  humano: { x: 50, y: 86, nombre: "Asesor humano", rol: "Casos sensibles", icono: "🧑‍💼" },
  bd: { x: 13, y: 82, nombre: "Base de datos", rol: "cartera · gestiones · reglas", icono: "🗄️" },
};
const ARISTAS: [ActorId, ActorId][] = [
  ["analista", "supervisor"], ["supervisor", "gestor"], ["supervisor", "cliente"], ["cliente", "gestor"],
  ["gestor", "humano"], ["humano", "supervisor"], ["supervisor", "bd"], ["analista", "bd"],
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RITMO_MS = 1200;

async function consumir(url: string, body: unknown, onMsg: (m: EventoStream) => void) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.body) throw new Error("Sin respuesta");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onMsg(JSON.parse(line) as EventoStream);
    }
  }
}

const FIN_TXT: Record<Fin["estado"], string> = {
  esperando_humano: "Esperando al asesor humano",
  promesa_registrada: "Promesa registrada",
  cerrado: "Caso cerrado",
  control: "Grupo de control (sin contacto)",
  sin_respuesta: "Sin promesa tras los turnos máximos",
  error: "Error",
};

export default function Visor({ clienteId, gestionesIniciales, conversacionInicial, esperandoInicial, modoInicial }: {
  clienteId: string; gestionesIniciales: Gestion[]; conversacionInicial: Turno[]; esperandoInicial: boolean; modoInicial: "llm" | "scripted";
}) {
  const [log, setLog] = useState<EventoAgente[]>([]);
  const [estado, setEstado] = useState<Estado>(esperandoInicial ? "esperando_humano" : "idle");
  const [fin, setFin] = useState<Fin | null>(null);
  const [gestiones, setGestiones] = useState(gestionesIniciales);
  const [conversacion, setConversacion] = useState(conversacionInicial);
  const [modo, setModo] = useState<"llm" | "scripted">(modoInicial);
  const [activo, setActivo] = useState<{ de?: ActorId; a?: ActorId }>({});
  const [paquete, setPaquete] = useState<{ key: number; de: ActorId; a: ActorId; go: boolean; estado: EventoAgente["estado"]; titulo: string } | null>(null);
  const [enVuelo, setEnVuelo] = useState<EventoAgente | null>(null);
  const [borrador, setBorrador] = useState("");
  const [resumen, setResumen] = useState("");
  const [seleccion, setSeleccion] = useState<EventoAgente | null>(null);
  const [error, setError] = useState("");

  const cola = useRef<Cola[]>([]);
  const reproduciendo = useRef(false);
  const streamTerminado = useRef(true);
  const logRef = useRef<HTMLDivElement>(null);

  const refrescar = useCallback(async () => {
    const r = await fetch(`/api/cliente/${clienteId}`, { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    setGestiones(d.gestiones);
    setConversacion(d.conversacion);
  }, [clienteId]);

  const reproducir = useCallback(async () => {
    if (reproduciendo.current) return;
    reproduciendo.current = true;
    try {
      for (;;) {
        const item = cola.current.shift();
        if (!item) {
          if (streamTerminado.current) break;
          await sleep(120);
          continue;
        }
        if (item.k === "fin") {
          setFin(item.fin);
          setActivo({});
          setEnVuelo(null);
          setPaquete(null);
          setEstado(item.fin.estado === "esperando_humano" ? "esperando_humano" : "terminado");
          if (item.fin.estado === "error") setError(item.fin.detalle ?? "Error");
          if (item.fin.estado === "esperando_humano") setResumen(item.fin.detalle ?? "");
          await refrescar();
          continue;
        }
        const ev = item.ev;
        setActivo({ de: ev.de, a: ev.a });
        setEnVuelo(ev);
        setLog((l) => [...l, ev]);
        setPaquete({ key: ev.id + Math.random(), de: ev.de, a: ev.a, go: false, estado: ev.estado, titulo: ev.titulo });
        await sleep(40);
        setPaquete((p) => (p ? { ...p, go: true } : p));
        if (ev.tipo === "escalamiento") {
          const d = ev.datos as { resumen?: string; borrador?: string } | undefined;
          if (d?.borrador) setBorrador(d.borrador);
          if (d?.resumen) setResumen(d.resumen);
        }
        await sleep(RITMO_MS);
        if (ev.tipo === "registro" || ev.tipo === "respuesta" || ev.tipo === "mensaje") void refrescar();
      }
    } finally {
      reproduciendo.current = false;
    }
  }, [refrescar]);

  const lanzar = useCallback(async (url: string, body: Record<string, unknown>, limpiar: boolean) => {
    setError("");
    setEstado("corriendo");
    setFin(null);
    if (limpiar) setLog([]);
    streamTerminado.current = false;
    void reproducir();
    try {
      await consumir(url, { ...body, clienteId, modo }, (m) => {
        if (m.tipo === "evento") cola.current.push({ k: "ev", ev: m.evento });
        else cola.current.push({ k: "fin", fin: m });
      });
    } catch (e) {
      cola.current.push({ k: "fin", fin: { tipo: "fin", estado: "error", detalle: (e as Error).message } });
    } finally {
      streamTerminado.current = true;
      void reproducir();
    }
  }, [clienteId, modo, reproducir]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [log.length]);

  const promesaPendiente = gestiones.some((g) => g.accion === "promesa" && g.estado_promesa === "pendiente");
  const ocupado = estado === "corriendo";

  const pos = (id: ActorId) => NODOS[id];
  /** El sobre se detiene antes del centro del nodo para no tapar su nombre. */
  const destino = (de: ActorId, a: ActorId) => ({ x: pos(de).x + (pos(a).x - pos(de).x) * 0.74, y: pos(de).y + (pos(a).y - pos(de).y) * 0.74 });
  const p = paquete;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" disabled={ocupado} onClick={() => { setBorrador(""); setResumen(""); void lanzar("/api/ciclo", {}, true); }}>
          ▶ Iniciar ciclo de cobranza
        </button>
        {promesaPendiente && (
          <button className="btn ghost" disabled={ocupado} onClick={() => void lanzar("/api/seguimiento", {}, false)}>⏩ Avanzar al día de la promesa</button>
        )}
        <label className="muted" style={{ marginLeft: "auto" }}>
          Agentes:{" "}
          <select value={modo} disabled={ocupado} onChange={(e) => setModo(e.target.value as "llm" | "scripted")}>
            <option value="llm">LLM (DeepSeek)</option>
            <option value="scripted">Reglas (sin LLM)</option>
          </select>
        </label>
        <span className={`estado ${estado}`}>{ocupado ? "● en curso" : fin ? FIN_TXT[fin.estado] : estado === "esperando_humano" ? "Esperando al asesor humano" : "Listo"}</span>
      </div>
      {error && <p className="err">{error}</p>}

      <div className="card diag-card">
        <div className="diag" aria-label="Diagrama en vivo de los agentes">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="diag-lines">
            {ARISTAS.map(([a, b]) => {
              const on = (activo.de === a && activo.a === b) || (activo.de === b && activo.a === a);
              return <line key={a + b} x1={pos(a).x} y1={pos(a).y} x2={pos(b).x} y2={pos(b).y} className={on ? "edge on" : "edge"} vectorEffect="non-scaling-stroke" />;
            })}
          </svg>
          {(Object.keys(NODOS) as ActorId[]).map((id) => {
            const n = NODOS[id];
            const cls = activo.de === id ? "nodo origen" : activo.a === id ? "nodo destino" : "nodo";
            return (
              <div key={id} className={`${cls} ${id === "humano" && estado === "esperando_humano" ? "espera" : ""}`} style={{ left: `${n.x}%`, top: `${n.y}%` }}>
                <span className="ico">{n.icono}</span>
                <b>{n.nombre}</b>
                <small>{n.rol}</small>
              </div>
            );
          })}
          {p && (
            <div
              key={p.key}
              className={`paquete ${p.estado}`}
              style={{ left: `${p.go ? destino(p.de, p.a).x : pos(p.de).x}%`, top: `${p.go ? destino(p.de, p.a).y : pos(p.de).y}%` }}
            >
              ✉
            </div>
          )}
        </div>
        <div className="vuelo" aria-live="polite">
          {enVuelo ? (
            <>
              <b>{NODOS[enVuelo.de].nombre} → {NODOS[enVuelo.a].nombre}</b> · {enVuelo.titulo}
              {enVuelo.texto && <div className="muted">{enVuelo.texto}</div>}
            </>
          ) : <span className="muted">Pulsa «Iniciar ciclo» para ver cómo se pasan el caso los agentes en tiempo real.</span>}
        </div>
      </div>

      {estado === "esperando_humano" && (
        <HumanoPanel resumen={resumen} borrador={borrador} onEnviar={(m) => { setBorrador(m); void lanzar("/api/humano", { accion: "enviar", mensaje: m }, false); }}
          onCerrar={() => void lanzar("/api/humano", { accion: "cerrar" }, false)} />
      )}

      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="card">
          <h2>Mensajes entre agentes</h2>
          <div className="logbox" ref={logRef}>
            {log.length === 0 && <p className="muted">Sin actividad todavía.</p>}
            {log.map((e) => (
              <button key={e.id + e.titulo} className={`logitem ${e.estado}`} onClick={() => setSeleccion(e)}>
                <span className="who">{NODOS[e.de].nombre} → {NODOS[e.a].nombre}</span>
                <span className="tit">{e.titulo}</span>
                {e.texto && <span className="txt">{e.texto}</span>}
              </button>
            ))}
          </div>
          {seleccion?.datos !== undefined && (
            <details className="muted" open style={{ marginTop: 8 }}>
              <summary>Datos del mensaje seleccionado</summary>
              <pre className="json">{JSON.stringify(seleccion.datos, null, 2)}</pre>
            </details>
          )}
        </div>
        <div className="card">
          <h2>Conversación con el cliente</h2>
          <div className="logbox">
            {conversacion.length === 0 && <p className="muted">Todavía no hay mensajes con el cliente.</p>}
            {conversacion.map((t, i) => (
              <div key={i} className={`bubble ${t.rol === "cliente" ? "in" : "out"}`}>
                <small>{t.rol === "gestor" ? "Gestor" : t.rol === "humano" ? "Asesor humano" : "Cliente"}</small>
                {t.texto}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card tablewrap" style={{ marginTop: 12 }}>
        <h2>Trazabilidad (tabla gestiones)</h2>
        <table>
          <thead><tr><th>#</th><th>Agente</th><th>Acción</th><th>Resultado</th><th>Motivo</th><th>Promesa</th><th>Justificación</th></tr></thead>
          <tbody>
            {gestiones.length === 0 && <tr><td colSpan={7} className="muted">Sin gestiones registradas.</td></tr>}
            {gestiones.map((g) => (
              <tr key={g.gestion_id}>
                <td>{g.gestion_id}</td><td>{g.agente}</td><td>{g.accion}{g.derivado_humano ? " · humano" : ""}</td><td>{g.resultado ?? ""}</td>
                <td>{g.motivo_no_pago ?? ""}</td>
                <td>{g.monto_promesa ? `S/ ${g.monto_promesa} · ${g.fecha_promesa} · ${g.estado_promesa}` : ""}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 380 }}>{g.justificacion ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HumanoPanel({ resumen, borrador, onEnviar, onCerrar }: { resumen: string; borrador: string; onEnviar: (m: string) => void; onCerrar: () => void }) {
  const [texto, setTexto] = useState(borrador);
  useEffect(() => { setTexto(borrador); }, [borrador]);
  return (
    <div className="card humano">
      <h2>🧑‍💼 Tu turno: el Gestor escaló este caso a una persona</h2>
      {resumen && <p><b>Resumen del Gestor:</b> {resumen}</p>}
      <label className="muted" htmlFor="h">Mensaje para el cliente (editable; el Supervisor lo validará antes de enviarlo)</label>
      <textarea id="h" rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} />
      <div className="row">
        <button className="btn" disabled={texto.trim().length < 5} onClick={() => onEnviar(texto)}>Enviar al Supervisor</button>
        <button className="btn ghost" onClick={onCerrar}>Cerrar caso</button>
      </div>
    </div>
  );
}
