import { maxDiasAutorizados, reglasDe } from "./reglas";
import type { ClientePublico, GestorResultado, Motivo, Regla, TurnoMeta } from "./types";

const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export type Solicitud = {
  noContactar: boolean;
  desconoceDeuda: boolean;
  pagoDeclarado: boolean;
  pideTasa: boolean;
  pideCondicionNoAutorizada: boolean;
  diasSolicitados: number | null;
  montoDisponible: number | null;
};

const RE = {
  noContactar: /no me (contacten|llamen|escriban|molesten|sigan)|dejen de (llamar|escribir|contactar)|no quiero (que me )?(contacten|llamen|escriban)|no me vuelvan a|dejenme en paz|\bstop\b/,
  desconoce: /no es mi deuda|esa deuda no es mia|no reconozco (esa|la|esta) deuda|no la contrate|no debo nada/,
  pagado: /ya pague|ya cancele|ya deposite|ya transferi|ya hice (el|la) (pago|deposito|transferencia)|pague ayer|ya esta pagad/,
  tasa: /(tasa|interes(es)?|tea|tcea).{0,30}(baj|reduc|men|rebaj)|(baj|reduc|rebaj).{0,30}(tasa|interes)/,
  noAutorizada: /descuento|condon|\bquita\b|perdon(en|ar)? (la )?(deuda|intereses)|refinanci|congel/,
};

/** Número de días pedido ("30 días", "un mes", "2 semanas", "la próxima semana"); null si no pide plazo. */
export function diasPedidos(t: string): number | null {
  const n = norm(t);
  let m = n.match(/(\d{1,3})\s*dias?/);
  if (m) return +m[1];
  m = n.match(/(\d{1,2})\s*semanas?/);
  if (m) return +m[1] * 7;
  if (/\bdos semanas\b/.test(n)) return 14;
  if (/\b(un|1) mes\b/.test(n)) return 30;
  if (/proxima semana|otra semana|una semana|\b1 semana\b/.test(n)) return 7;
  return null;
}

/** Monto que el cliente dice poder pagar (S/ 300, 300 soles). Prefiere el que sigue a "pagar/abonar/ahora". */
export function montoOfrecido(t: string): number | null {
  const n = norm(t);
  const found: { v: number; i: number }[] = [];
  for (const m of n.matchAll(/s\/\.?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?|(\d{1,3}(?:[.,]\d{3})+|\d+)\s*soles/g)) {
    const raw = (m[1] ?? m[2]).replace(/[.,](?=\d{3})/g, "");
    found.push({ v: Number(raw), i: m.index ?? 0 });
  }
  if (!found.length) return null;
  const cerca = found.find((f) => /(pagar|abonar|depositar|cancelar|ahora|puedo)\s*[^s]{0,12}$/.test(n.slice(Math.max(0, f.i - 25), f.i)));
  return (cerca ?? found[found.length - 1]).v;
}

export function interpretarSolicitud(texto: string): Solicitud {
  const n = norm(texto);
  return {
    noContactar: RE.noContactar.test(n), desconoceDeuda: RE.desconoce.test(n), pagoDeclarado: RE.pagado.test(n),
    pideTasa: RE.tasa.test(n), pideCondicionNoAutorizada: RE.noAutorizada.test(n),
    diasSolicitados: diasPedidos(texto), montoDisponible: montoOfrecido(texto),
  };
}

export type Forzado = {
  accion: "escalar_humano" | "cerrar"; motivo: Motivo; razon: string; mensaje: string; resumen: string; borrador: string;
  /** Efecto persistente además de la derivación. */
  efecto?: "opt_out" | "pago_declarado";
};

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { maximumFractionDigits: 2 })}`;

/**
 * Guardrail DETERMINÍSTICO del Supervisor sobre lo que dijo el cliente. Se aplica sobre cualquier Gestor (LLM o reglas):
 * el LLM interpreta y redacta, pero no puede aprobar condiciones que las reglas no autorizan.
 * Devuelve null si nada obliga a derivar; en ese caso el flujo normal (y validarAcuerdo) decide.
 */
export function guardrailSolicitud(texto: string, c: ClientePublico, reglas: Regla[]): Forzado | null {
  if (!texto.trim()) return null;
  const s = interpretarSolicitud(texto);
  const primer = c.nombre.split(" ")[0];
  const resumenBase = `Cliente ${c.nombre} (${c.producto}, deuda ${money(c.saldo_deuda)}, cuota ${money(c.monto_cuota)}, atraso ${c.dias_atraso} d). Dijo: "${texto.slice(0, 280)}"`;
  const caso = (f: Omit<Forzado, "resumen" | "borrador"> & { borrador?: string }): Forzado => ({
    ...f, resumen: `${resumenBase} → ${f.razon}`,
    borrador: f.borrador ?? `Hola ${primer}, soy asesor de tu banco. Vi tu solicitud y quiero revisarla contigo. Te cuento qué opciones sí están autorizadas y evaluamos lo demás.`,
  });

  if (s.noContactar) return caso({ accion: "cerrar", motivo: "no_contactar", efecto: "opt_out", razon: "El cliente pidió no ser contactado.",
    mensaje: "Entendido. Respetaremos tu solicitud y no volveremos a contactarte para esta gestión." });
  if (s.desconoceDeuda) return caso({ accion: "escalar_humano", motivo: "desconoce_deuda", razon: "El cliente no reconoce la deuda: se suspende la negociación y se deriva a revisión.",
    mensaje: "Gracias por avisarnos. Mientras revisamos tu caso no te haremos ninguna propuesta de pago; un asesor te contactará." });
  if (s.pagoDeclarado) return caso({ accion: "escalar_humano", motivo: "pago_declarado", efecto: "pago_declarado", razon: "El cliente dice que ya pagó; el pago NO está confirmado: requiere conciliación.",
    mensaje: "Gracias por avisarnos. Vamos a verificar tu pago con el banco; hasta confirmarlo no lo damos por registrado, y mientras tanto no haremos nuevas gestiones de cobro." });
  if (s.pideTasa || s.pideCondicionNoAutorizada) return caso({ accion: "escalar_humano", motivo: "solicitud_fuera_de_politica",
    razon: s.pideTasa ? "Pide reducir la tasa: no existe una política que lo autorice." : "Pide un descuento/condonación/refinanciamiento: no hay regla que lo autorice.",
    mensaje: s.pideTasa
      ? "No tengo una política que me permita ofrecerte una reducción de tasa. Voy a derivar tu solicitud a un asesor para que la evalúe; no es una promesa de aprobación."
      : "No tengo una política que me permita ofrecer descuentos, condonaciones o refinanciamientos. Derivo tu solicitud a un asesor para que la evalúe; no es una promesa de aprobación." });

  const max = maxDiasAutorizados(reglas);
  if (s.diasSolicitados !== null && s.diasSolicitados > max) return caso({ accion: "escalar_humano", motivo: "solicitud_fuera_de_politica",
    razon: `Pide ${s.diasSolicitados} días; lo máximo autorizado por las reglas es ${max}.`,
    mensaje: `La reprogramación que puedo ofrecerte llega hasta ${max} días y tu pedido de ${s.diasSolicitados} días la excede. No lo doy por aprobado: lo derivo a un asesor para evaluarlo.` });

  const fracciona = reglasDe(reglas, "opcion_pago").some((r) => /fraccionar/.test(r.valor.toLowerCase()) && /dias_atraso/.test(r.condicion.toLowerCase()) && c.dias_atraso >= 1 && c.dias_atraso <= 30);
  if (s.montoDisponible !== null && s.montoDisponible > 0 && s.montoDisponible < c.monto_cuota) {
    const autorizado = fracciona && Math.abs(s.montoDisponible - c.monto_cuota / 2) <= 1;
    if (!autorizado) return caso({ accion: "escalar_humano", motivo: "solicitud_fuera_de_politica",
      razon: `Puede pagar ${money(s.montoDisponible)} ahora (cuota ${money(c.monto_cuota)}, deuda ${money(c.saldo_deuda)}); un pago parcial por ese monto no es una opción autorizada.`,
      mensaje: `Gracias por contarme que puedes pagar ${money(s.montoDisponible)} ahora. Dejo ese monto anotado como tu disponibilidad, pero un acuerdo por ese importe necesita la aprobación de un asesor: todavía no queda aprobado.` });
  }
  return null;
}

/** Aplica el guardrail a un turno del Gestor: cambia la acción, el motivo y el mensaje por los determinísticos y deja la traza. */
export function aplicarForzado(turno: GestorResultado, f: Forzado): GestorResultado {
  const meta: TurnoMeta = { ...(turno.meta ?? { motor: "reglas" }), guardrail: f.razon };
  return {
    ...turno, accion: f.accion, motivo_no_pago: f.motivo, regla_id: null, monto_promesa: null, fecha_promesa: null,
    mensaje: f.mensaje, justificacion: `Guardrail del Supervisor: ${f.razon}`,
    resumen_humano: f.accion === "escalar_humano" ? f.resumen : null, borrador_humano: f.accion === "escalar_humano" ? f.borrador : null, meta,
  };
}
