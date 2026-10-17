import type { GestionRepository, ToneChecker } from "./ports";
import { diasEntre, evalCondicion, maxContactosSemana, maxDiasOpcion, palabrasProhibidas, reglasDe, sumarDias, violaHorario } from "./reglas";
import type { ClientePublico, GestorTurn, Propuesta, Regla } from "./types";

export type Validacion = { ok: boolean; rechazos: string[]; avisos: string[]; feedback: string };

/** Supervisor: valida propuestas y mensajes contra la tabla `reglas` (cumplimiento). */
export function validarPropuesta(
  p: Propuesta, reglas: Regla[], contactosPrevios: number,
): Validacion {
  const rechazos: string[] = [];
  const h = violaHorario(reglas, p.fecha, p.hora);
  if (h) rechazos.push(`Horario no permitido: ${h}`);
  const max = maxContactosSemana(reglas);
  if (contactosPrevios >= max) rechazos.push(`Límite de contacto: ya hubo ${contactosPrevios} contacto(s) en 7 días (máx. ${max})`);
  return { ok: rechazos.length === 0, rechazos, avisos: [], feedback: rechazos.join(" | ") };
}

export async function validarMensaje(
  d: { tono: ToneChecker },
  i: { mensaje: string; turno?: GestorTurn; cliente: ClientePublico; reglas: Regla[]; hoy: string; soloLenguaje?: boolean },
): Promise<Validacion> {
  const rechazos: string[] = [];
  const avisos: string[] = [];
  const m = i.mensaje.toLowerCase();

  if (/\[[^\]]+\]|\{\{|<[a-z]+>/i.test(i.mensaje)) rechazos.push("El mensaje contiene un marcador sin completar (p. ej. [Nombre])");
  const prohibida = palabrasProhibidas(i.reglas).find((w) => m.includes(w));
  if (prohibida) rechazos.push(`Lenguaje prohibido: "${prohibida}"`);
  if (i.mensaje.trim().length < 5) rechazos.push("Mensaje vacío");

  const p = await d.tono.respetuoso(i.mensaje);
  if (p < 0.4) rechazos.push(`Tono inadecuado (probabilidad de ser respetuoso ${(p * 100).toFixed(0)} %)`);
  else if (p < 0.7) avisos.push(`Tono mejorable (${(p * 100).toFixed(0)} %)`);

  const t = i.turno;
  if (t && !i.soloLenguaje) {
    if (t.accion === "ofrecer" || t.accion === "registrar_promesa") {
      const r = reglasDe(i.reglas, "opcion_pago").find((x) => x.regla_id === t.regla_id);
      if (!r) rechazos.push("Ofreciste una opción que no existe en la tabla de reglas (regla_id inválido); usa solo opciones de tipo opcion_pago");
      else if (!evalCondicion(r.condicion, { motivo: t.motivo_no_pago, dias_atraso: i.cliente.dias_atraso })) {
        rechazos.push(`La regla ${r.regla_id} ("${r.valor}") no aplica a este cliente (condición: ${r.condicion}; motivo=${t.motivo_no_pago}, dias_atraso=${i.cliente.dias_atraso})`);
      } else if (t.accion === "registrar_promesa") {
        const max = maxDiasOpcion(r);
        if (!t.monto_promesa || t.monto_promesa <= 0) rechazos.push("Falta monto_promesa válido");
        else if (t.monto_promesa > i.cliente.saldo_deuda) rechazos.push("El monto prometido supera el saldo de la deuda");
        if (!t.fecha_promesa || !/^\d{4}-\d{2}-\d{2}$/.test(t.fecha_promesa)) rechazos.push("Falta fecha_promesa en formato YYYY-MM-DD");
        else {
          const dd = diasEntre(i.hoy, t.fecha_promesa);
          if (dd < 0) rechazos.push("La fecha prometida está en el pasado");
          else if (max !== null && dd > max) rechazos.push(`La regla ${r.regla_id} permite mover la fecha hasta ${max} días; pediste ${dd} (máx. ${sumarDias(i.hoy, max)})`);
        }
      }
    }
  }
  return { ok: rechazos.length === 0, rechazos, avisos, feedback: rechazos.join(" | ") };
}

export async function contactosPrevios(g: GestionRepository, clienteId: string, ahora: Date): Promise<number> {
  const desde = new Date(ahora.getTime() - 7 * 86400000).toISOString();
  return g.contactosIniciales(clienteId, desde);
}
