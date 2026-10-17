import type { EstadoContacto, Gestion } from "./types";

export type Bloqueo = "disputa" | "pago_declarado" | "no_contactar" | null;

export type EstadoCaso = {
  contacto: EstadoContacto;
  /** El último paso derivó el caso a una persona y aún no actuó. */
  esperandoHumano: boolean;
  /** Impide ofrecer opciones, registrar promesas o contactar mientras dure. */
  bloqueo: Bloqueo;
  /** Contactos consecutivos sin respuesta (se reinicia cuando el cliente responde). */
  intentosSinRespuesta: number;
  programadoPara: string | null;
};

const MOTIVOS_DISPUTA = ["desconoce_deuda", "reclamo"];

/**
 * Deriva el estado real del caso SOLO de la tabla `gestiones` (nada vive en memoria del cliente).
 * Convención: accion `programar_contacto` (programado), `contacto_inicial` (enviado simulado), `responder` (cliente),
 * `sin_respuesta`, `pago_declarado`, `pago_confirmado`, `disputa_resuelta`, `opt_out`, `cierre_*`.
 */
export function estadoCaso(gs: Gestion[], motivosDisputa: string[] = MOTIVOS_DISPUTA): EstadoCaso {
  const e: EstadoCaso = { contacto: "ninguno", esperandoHumano: false, bloqueo: null, intentosSinRespuesta: 0, programadoPara: null };
  let disputa = false, pagoDeclarado = false, optOut = false;
  for (const g of gs) {
    switch (g.accion) {
      case "validar": if (g.resultado === "aprobado" && g.mensaje === null) e.contacto = "validado"; break;
      case "programar_contacto": e.contacto = "programado"; e.programadoPara = g.programado_para; e.esperandoHumano = false; break;
      case "contacto_inicial": e.contacto = "enviado_simulado"; e.programadoPara = null; break;
      case "responder": e.contacto = "respuesta_recibida"; e.intentosSinRespuesta = 0; break;
      case "sin_respuesta": e.contacto = "sin_respuesta"; e.intentosSinRespuesta++; break;
      case "promesa": e.contacto = "cerrado"; break;
      case "cerrar": case "cierre_por_pago": e.contacto = "cerrado"; e.esperandoHumano = false; break;
      case "opt_out": optOut = true; e.contacto = "cerrado"; e.esperandoHumano = false; break;
      case "pago_declarado": pagoDeclarado = true; break;
      case "pago_confirmado": case "pago_verificado": pagoDeclarado = false; break;
      case "disputa_resuelta": disputa = false; break;
    }
    if (g.agente === "gestor" && g.motivo_no_pago && motivosDisputa.includes(g.motivo_no_pago)) disputa = true;
    if (g.derivado_humano && (g.agente === "gestor" || g.accion === "escalar")) { e.esperandoHumano = true; e.contacto = "escalado"; }
    else if (g.agente === "humano" && g.accion === "conversar") { e.esperandoHumano = false; e.contacto = "enviado_simulado"; }
  }
  e.bloqueo = optOut ? "no_contactar" : disputa ? "disputa" : pagoDeclarado ? "pago_declarado" : null;
  return e;
}

export const TXT_BLOQUEO: Record<Exclude<Bloqueo, null>, string> = {
  disputa: "Hay una disputa o reclamo abierto: la negociación está suspendida hasta revisión humana.",
  pago_declarado: "El cliente informó un pago que aún no se concilió: no se hacen nuevas gestiones de cobro hasta verificarlo.",
  no_contactar: "El cliente pidió no ser contactado: el caso está cerrado para gestión.",
};
