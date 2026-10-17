"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MotorBadge } from "@/components/Motor";
import { adminPost, errorDe } from "@/lib/client";
import { borradorSupervisor } from "@/lib/core/borrador-supervisor";
import type { EstadoCaso } from "@/lib/core/estado";
import type { ActorId, EventoAgente, EventoStream, Gestion, Pago, Turno, TurnoMeta } from "@/lib/core/types";

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
const RITMO_MS = 900;

async function consumir(url: string, body: unknown, onMsg: (m: EventoStream) => void) {
  const r = await adminPost(url, body);
  if (!r.ok) throw new Error(await errorDe(r));
  if (!r.body) throw new Error("Sin respuesta del servidor");
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
  promesa_registrada: "Promesa registrada (no es un pago)",
  cerrado: "Caso cerrado",
  control: "Grupo de control (sin contacto)",
  sin_respuesta: "Sin promesa tras los turnos máximos",
  contacto_programado: "Contacto programado · aún no se contactó a nadie",
  reintento_programado: "Sin respuesta · reintento programado",
  bloqueado: "Caso suspendido (disputa, pago por conciliar o no contactar)",
  error: "Error",
};

const PASOS: { k: string; t: string; alerta?: boolean }[] = [
  { k: "validado", t: "Validado" }, { k: "programado", t: "Programado" }, { k: "enviado_simulado", t: "Enviado (simulado)" },
  { k: "respuesta_recibida", t: "Respuesta recibida" }, { k: "sin_respuesta", t: "Sin respuesta", alerta: true },
  { k: "escalado", t: "Escalado a una persona", alerta: true }, { k: "cerrado", t: "Cerrado" },
];

const PROMESA_TXT: Record<string, string> = {
  pendiente: "pendiente", cumplida: "cumplida · pago CONFIRMADO", cumplida_simulada: "cumplida · pago SIMULADO", rota: "incumplida", cancelada: "cancelada (obsoleta)",
};

type Resumen = { deuda: number; cuota: number; atraso: number; canal: string; nombre: string };
type Escenario = { k: string; t: string; texto: (r: Resumen) => string; silencio?: boolean };
const ESCENARIOS: Escenario[] = [
  { k: "auto", t: "El cliente simulado responde solo", texto: () => "" },
  { k: "A", t: "A · Retraso salarial", texto: () => "No me pagaron este mes. Me depositan la próxima semana." },
  { k: "B", t: "B · Pago parcial", texto: (r) => `Debo S/${r.deuda}, pero ahora puedo pagar S/${Math.max(Math.round(r.cuota * 0.35), 1)}.` },
  { k: "C", t: "C · Pide 30 días", texto: () => "Necesito 30 días para completar el pago." },
  { k: "D", t: "D · Reducción de tasa", texto: () => "¿Pueden bajarme la tasa?" },
  { k: "E", t: "E · Desconoce la deuda", texto: () => "Esa deuda no es mía." },
  { k: "F", t: "F · No responde (silencio)", texto: () => "", silencio: true },
  { k: "G", t: "G · Dice que ya pagó", texto: () => "Ya pagué ayer, revisen por favor." },
  { k: "libre", t: "Escribir otra respuesta…", texto: () => "" },
];

export default function Visor({ clienteId, resumen, gestionesIniciales, conversacionInicial, estadoInicial, pagosIniciales, modoInicial, llmDisponible, opciones }: {
  clienteId: string; resumen: Resumen; gestionesIniciales: Gestion[]; conversacionInicial: Turno[]; estadoInicial: EstadoCaso; pagosIniciales: Pago[];
  modoInicial: "llm" | "scripted"; llmDisponible: boolean; opciones: string[];
}) {
  const [log, setLog] = useState<EventoAgente[]>([]);
  const [estado, setEstado] = useState<Estado>(estadoInicial.esperandoHumano ? "esperando_humano" : "idle");
  const [caso, setCaso] = useState<EstadoCaso>(estadoInicial);
  const [fin, setFin] = useState<Fin | null>(null);
  const [gestiones, setGestiones] = useState(gestionesIniciales);
  const [pagos, setPagos] = useState(pagosIniciales);
  const [conversacion, setConversacion] = useState(conversacionInicial);
  const [modo, setModo] = useState<"llm" | "scripted">(modoInicial);
  const [esc, setEsc] = useState("auto");
  const [textoLibre, setTextoLibre] = useState("");
  const [activo, setActivo] = useState<{ de?: ActorId; a?: ActorId }>({});
  const [paquete, setPaquete] = useState<{ key: number; de: ActorId; a: ActorId; go: boolean; estado: EventoAgente["estado"]; titulo: string } | null>(null);
  const [enVuelo, setEnVuelo] = useState<EventoAgente | null>(null);
  const [borrador, setBorrador] = useState(() => borradorSupervisor(resumen.nombre));
  const [resumenGestor, setResumenGestor] = useState("");
  const [seleccion, setSeleccion] = useState<EventoAgente | null>(null);
  const [error, setError] = useState("");
  const [monto, setMonto] = useState("");

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
    setCaso(d.estado);
    setPagos(d.pagos);
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
          if (item.fin.estado === "esperando_humano") setResumenGestor(item.fin.detalle ?? "");
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
          setBorrador(d?.borrador || borradorSupervisor(resumen.nombre));
          if (d?.resumen) setResumenGestor(d.resumen);
        }
        await sleep(RITMO_MS);
        if (ev.tipo === "registro" || ev.tipo === "respuesta" || ev.tipo === "mensaje") void refrescar();
      }
    } finally {
      reproduciendo.current = false;
    }
  }, [refrescar, resumen.nombre]);

  const lanzar = useCallback(async (url: string, body: Record<string, unknown>, limpiar: boolean) => {
    setError("");
    setEstado("corriendo");
    setFin(null);
    if (limpiar) {
      setLog([]);
      setBorrador(borradorSupervisor(resumen.nombre));
    }
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
  }, [clienteId, modo, reproducir, resumen.nombre]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [log.length]);

  const escenario = ESCENARIOS.find((x) => x.k === esc) ?? ESCENARIOS[0];
  const textoCliente = esc === "libre" ? textoLibre.trim() : escenario.texto(resumen);
  const datosCliente = () => ({ silencio: escenario.silencio ? true : undefined, respuestasCliente: textoCliente ? [textoCliente] : undefined });

  const promesaPendiente = gestiones.some((g) => g.accion === "promesa" && g.estado_promesa === "pendiente");
  const ocupado = estado === "corriendo";
  const programado = caso.contacto === "programado";
  const suspendido = caso.bloqueo !== null;
  const ultimoGestor = [...log].reverse().find((e) => e.de === "gestor" && e.tipo === "mensaje");
  const metaUlt = (ultimoGestor?.datos as { meta?: TurnoMeta } | undefined)?.meta;

  const pos = (id: ActorId) => NODOS[id];
  const destino = (de: ActorId, a: ActorId) => ({ x: pos(de).x + (pos(a).x - pos(de).x) * 0.74, y: pos(de).y + (pos(a).y - pos(de).y) * 0.74 });
  const p = paquete;

  async function registrarPago() {
    setError("");
    const m = Number(monto.replace(",", "."));
    if (!(m > 0)) { setError("Escribe un monto mayor que cero."); return; }
    const r = await adminPost("/api/pagos", { clienteId, referencia: `OP-${Date.now()}`, monto: m });
    if (!r.ok) { setError(await errorDe(r)); return; }
    setMonto("");
    await refrescar();
    setFin({ tipo: "fin", estado: "cerrado", detalle: "Pago confirmado registrado" });
  }

  return (
    <div>

      {modo === "llm" && !llmDisponible && (
        <div className="aviso">⚠️ El modo <b>LLM (DeepSeek)</b> no está disponible en este servidor (falta <code>OPENROUTER_API_KEY</code>). Si lo eliges se ejecutarán <b>reglas</b> y así se etiquetará: no se simula una llamada al LLM.</div>
      )}
      <div className="aviso sim"><b>Qué es real y qué es simulado:</b> el Analista (modelo logístico sobre datos sintéticos), el Supervisor (reglas) y la base son reales; el cliente, el envío de mensajes, el calendario y los pagos del seguimiento son <b>simulaciones</b>. Nada se envía a nadie ni hay conciliación bancaria.</div>

      <div className="pasos" aria-label="Estado del contacto">
        <span className="muted">Contacto:</span>
        <span className={`paso ${ocupado && caso.contacto === "ninguno" ? "on" : ""}`}>Propuesto</span>
        {PASOS.map((s) => <span key={s.k} className={`paso ${s.alerta ? "alerta" : ""} ${caso.contacto === s.k ? "on" : ""}`}>{s.t}</span>)}
        {caso.programadoPara && <span className="muted">· para {caso.programadoPara.replace("T", " ")}</span>}
        {caso.bloqueo && <span className="chip alto">suspendido: {caso.bloqueo.replace("_", " ")}</span>}
      </div>

      <div className="controles">
        <label>Respuesta del cliente (simulación)
          <select value={esc} disabled={ocupado} onChange={(e) => setEsc(e.target.value)}>
            {ESCENARIOS.map((x) => <option key={x.k} value={x.k}>{x.t}</option>)}
          </select>
        </label>
        {esc === "libre" && <label>Texto<input value={textoLibre} maxLength={400} onChange={(e) => setTextoLibre(e.target.value)} placeholder="Lo que diría el cliente" style={{ minWidth: 260 }} /></label>}
        {textoCliente && esc !== "libre" && <span className="muted" style={{ alignSelf: "center" }}>“{textoCliente}”</span>}
        <label>Agentes
          <select value={modo} disabled={ocupado} onChange={(e) => setModo(e.target.value as "llm" | "scripted")}>
            <option value="llm">LLM (DeepSeek){llmDisponible ? "" : " — no disponible"}</option>
            <option value="scripted">Reglas (sin LLM)</option>
          </select>
        </label>
        <span className={`estado ${estado}`}>{ocupado ? "● en curso…" : fin ? FIN_TXT[fin.estado] : estado === "esperando_humano" ? "Esperando al asesor humano" : "Listo"}</span>
        {metaUlt && <span>Último Gestor: <MotorBadge de="gestor" meta={metaUlt} /></span>}
      </div>

      <div className="btnrow">
        <button className="btn" disabled={ocupado || programado || caso.esperandoHumano || suspendido}
          onClick={() => { setBorrador(""); setResumenGestor(""); void lanzar("/api/ciclo", { fase: "planificar" }, true); }}>① Analizar y programar contacto</button>
        <button className="btn" disabled={ocupado || !programado || suspendido}
          onClick={() => void lanzar("/api/ciclo", { fase: "ejecutar", ...datosCliente() }, false)}>② Simular llegada de la fecha y ejecutar contacto</button>
        <button className="btn ghost" disabled={ocupado || caso.esperandoHumano || suspendido}
          onClick={() => { setBorrador(""); setResumenGestor(""); void lanzar("/api/ciclo", { fase: "todo", ...datosCliente() }, true); }}>Todo seguido (modo lote)</button>
        {promesaPendiente && (
          <button className="btn ghost" disabled={ocupado} onClick={() => void lanzar("/api/seguimiento", {}, false)}>⏩ Avanzar al día de la promesa (simulación)</button>
        )}
      </div>
      {error && <p className="err" role="alert">{error}</p>}

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
            <div key={p.key} className={`paquete ${p.estado}`}
              style={{ left: `${p.go ? destino(p.de, p.a).x : pos(p.de).x}%`, top: `${p.go ? destino(p.de, p.a).y : pos(p.de).y}%` }}>✉</div>
          )}
        </div>
        <div className="vuelo" aria-live="polite">
          {enVuelo ? (
            <>
              <b>{NODOS[enVuelo.de].nombre} → {NODOS[enVuelo.a].nombre}</b> · {enVuelo.titulo}
              <MotorBadge de={enVuelo.de} meta={(enVuelo.datos as { meta?: TurnoMeta } | undefined)?.meta} />
              {enVuelo.texto && <div className="muted">{enVuelo.texto}</div>}
            </>
          ) : <span className="muted">Paso ①: el Analista propone y el Supervisor valida y programa el contacto (nada se envía). Paso ②: se simula que llega la fecha y se ejecuta el contacto.</span>}
        </div>
      </div>

      {estado === "esperando_humano" && (
        <HumanoPanel resumen={resumenGestor} borrador={borrador} caso={caso} datos={resumen} opciones={opciones} gestiones={gestiones} conversacion={conversacion} disabled={ocupado}
          onEnviar={(m, silencio) => { setBorrador(m); void lanzar("/api/humano", { accion: "enviar", mensaje: m, silencio: silencio || undefined, respuestasCliente: textoCliente && !silencio ? [textoCliente] : undefined }, false); }}
          onCerrar={() => void lanzar("/api/humano", { accion: "cerrar" }, false)}
          onLevantar={(nota) => void lanzar("/api/humano", { accion: "levantar_bloqueo", nota }, false)} />
      )}

      <details className="card" style={{ marginTop: 12 }}>
        <summary>💳 Conciliación: registrar un pago CONFIRMADO ({pagos.filter((x) => x.estado === "confirmado").length} confirmados · {pagos.filter((x) => x.estado === "simulado").length} simulados)</summary>
        <p className="muted">No hay integración bancaria: esto representa el evento autorizado de conciliación. Es idempotente por referencia y no deja el saldo negativo. Las promesas <b>no</b> son pagos.</p>
        <div className="controles">
          <label>Monto (S/)<input inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value)} placeholder="300" /></label>
          <button className="btn ghost" disabled={ocupado} onClick={() => void registrarPago()}>Registrar pago confirmado</button>
        </div>
        {pagos.length > 0 && (
          <table><thead><tr><th>Referencia</th><th className="num">Monto</th><th>Origen</th><th>Estado</th></tr></thead>
            <tbody>{pagos.map((x) => <tr key={x.pago_id}><td>{x.referencia}</td><td className="num">S/ {x.monto}</td><td>{x.origen === "simulador" ? "simulador (demo)" : "conciliación"}</td><td>{x.estado === "simulado" ? <span className="motor sim">SIMULADO · no mueve saldo</span> : <span className="motor llm">CONFIRMADO</span>}</td></tr>)}</tbody></table>
        )}
      </details>

      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="card">
          <h2>Mensajes entre agentes</h2>
          <div className="logbox" ref={logRef}>
            {log.length === 0 && <p className="muted">Sin actividad todavía.</p>}
            {log.map((e) => (
              <button key={e.id + e.titulo} className={`logitem ${e.estado}`} onClick={() => setSeleccion(e)}>
                <span className="who">{NODOS[e.de].nombre} → {NODOS[e.a].nombre}<MotorBadge de={e.de} meta={(e.datos as { meta?: TurnoMeta } | undefined)?.meta} /></span>
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
          <h2>Historial de la negociación</h2>
          <div className="logbox">
            {conversacion.length === 0 && <p className="muted">Todavía no hay mensajes con el cliente.</p>}
            {conversacion.map((t, i) => (
              <div key={i} className={`bubble ${t.rol === "cliente" ? "in" : "out"}`}>
                <small>{t.rol === "gestor" ? "Gestor" : t.rol === "humano" ? "Asesor humano" : "Cliente (simulado)"}</small>
                {t.texto}
              </div>
            ))}
            {gestiones.filter((g) => g.accion === "sin_respuesta").map((g) => <p key={g.gestion_id} className="muted">⏳ Sin respuesta registrada (#{g.gestion_id}).</p>)}
          </div>
        </div>
      </div>

      <div className="card tablewrap" style={{ marginTop: 12 }}>
        <h2>Trazabilidad (tabla gestiones)</h2>
        <table>
          <thead><tr><th>#</th><th>Agente</th><th>Acción</th><th>Resultado</th><th>Motivo</th><th>Promesa</th><th>Motor</th><th>Origen · aprobación</th><th>Justificación</th></tr></thead>
          <tbody>
            {gestiones.length === 0 && <tr><td colSpan={9} className="muted">Sin gestiones registradas.</td></tr>}
            {gestiones.map((g) => (
              <tr key={g.gestion_id}>
                <td>{g.gestion_id}</td><td>{g.agente}</td><td>{g.accion}{g.derivado_humano ? " · humano" : ""}{g.programado_para ? ` · ${g.programado_para.replace("T", " ")}` : ""}</td><td>{g.resultado ?? ""}</td>
                <td>{g.motivo_no_pago ?? ""}</td>
                <td>{g.monto_promesa ? `S/ ${g.monto_promesa} · ${g.fecha_promesa} · ${PROMESA_TXT[g.estado_promesa ?? ""] ?? g.estado_promesa ?? ""}` : ""}</td>
                <td>{g.motor ?? ""}</td><td>{g.origen ?? ""}{g.aprobacion ? ` · ${g.aprobacion}` : ""}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 360 }}>{g.justificacion ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HumanoPanel({ resumen, borrador, caso, datos, opciones, gestiones, conversacion, disabled, onEnviar, onCerrar, onLevantar }: {
  resumen: string; borrador: string; caso: EstadoCaso; datos: Resumen; opciones: string[]; gestiones: Gestion[]; conversacion: Turno[]; disabled: boolean;
  onEnviar: (m: string, silencio: boolean) => void; onCerrar: () => void; onLevantar: (nota: string) => void;
}) {
  const [texto, setTexto] = useState(borrador);
  const [nota, setNota] = useState("");
  const [silencio, setSilencio] = useState(false);
  useEffect(() => { setTexto(borrador); }, [borrador]);
  const motivo = [...gestiones].reverse().find((g) => g.motivo_no_pago)?.motivo_no_pago ?? "—";
  const ultCliente = [...conversacion].reverse().find((t) => t.rol === "cliente")?.texto;
  return (
    <div className="card humano">
      <h2>🧑‍💼 Tu turno: el caso fue derivado a una persona</h2>
      <div className="resumen-caso" aria-label="Resumen del caso para el asesor">
        <span><b>{datos.nombre}</b>canal {datos.canal}</span>
        <span><b>S/ {datos.deuda}</b>deuda pendiente</span>
        <span><b>S/ {datos.cuota}</b>cuota</span>
        <span><b>{datos.atraso} d</b>de atraso</span>
        <span><b>{motivo.replace(/_/g, " ")}</b>motivo identificado</span>
        <span><b>{caso.intentosSinRespuesta}</b>intentos sin respuesta</span>
      </div>
      {resumen && <p><b>Resumen del Gestor:</b> {resumen}</p>}
      {ultCliente && <p><b>Lo último que dijo el cliente:</b> “{ultCliente}”</p>}
      <p className="muted"><b>Opciones autorizadas hoy:</b> {opciones.length ? opciones.join(" · ") : "ninguna"}. Cualquier otra condición (tasa, descuento, plazos mayores) <b>no existe</b>: el Supervisor rechaza mensajes y acuerdos que la ofrezcan.</p>
      {caso.bloqueo && caso.bloqueo !== "no_contactar" && (
        <div className="aviso">
          <b>Caso suspendido:</b> {caso.bloqueo === "disputa" ? "hay una disputa abierta." : "el cliente dice que ya pagó y falta conciliar."} Mientras dure no se registran promesas.
          <div className="row">
            <input style={{ flex: 1 }} placeholder="Resultado de tu verificación (mín. 10 caracteres)" value={nota} onChange={(e) => setNota(e.target.value)} />
            <button className="btn ghost" disabled={disabled || nota.trim().length < 10} onClick={() => { onLevantar(nota.trim()); setNota(""); }}>
              {caso.bloqueo === "disputa" ? "Registrar disputa resuelta" : "Registrar que no encontré el pago"}
            </button>
          </div>
        </div>
      )}
      <label className="muted" htmlFor="h">Mensaje del Supervisor para {datos.nombre} (editable; sujeto a validación antes de enviarlo)</label>
      <textarea id="h" rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} />
      <label className="muted"><input type="checkbox" checked={silencio} onChange={(e) => setSilencio(e.target.checked)} /> Simular que el cliente no responde al asesor</label>
      <div className="row">
        <button className="btn" disabled={disabled || texto.trim().length < 5} onClick={() => onEnviar(texto, silencio)}>Enviar al Supervisor</button>
        <button className="btn ghost" disabled={disabled} onClick={onCerrar}>Cerrar caso</button>
      </div>
    </div>
  );
}
