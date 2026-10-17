import type { Regla } from "./types";

export const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;

export const isoDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const sumarDias = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
export const diasEntre = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86400000);

/**
 * Evalúa condiciones de la tabla `reglas`. Formatos admitidos (separados por ';'):
 *   "motivo = a, b"   "dias_atraso 1–30"   "dias_atraso <= 30"   "siempre" / "por cliente"
 * Una condición que no se entiende se considera NO cumplida (criterio conservador).
 */
export function evalCondicion(cond: string, ctx: { motivo?: string; dias_atraso?: number }): boolean {
  return cond.split(";").every((raw) => {
    const c = raw.trim().toLowerCase();
    if (!c || c === "siempre" || c === "por cliente") return true;
    let m = c.match(/^motivo\s*=\s*(.+)$/);
    if (m) return m[1].split(",").map((s) => s.trim()).includes((ctx.motivo ?? "").toLowerCase());
    m = c.match(/^dias_atraso\s*(\d+)\s*[–-]\s*(\d+)$/);
    if (m) return ctx.dias_atraso !== undefined && ctx.dias_atraso >= +m[1] && ctx.dias_atraso <= +m[2];
    m = c.match(/^dias_atraso\s*(<=|>=|<|>)\s*(\d+)$/);
    if (m) {
      const d = ctx.dias_atraso ?? NaN, n = +m[2];
      return m[1] === "<=" ? d <= n : m[1] === ">=" ? d >= n : m[1] === "<" ? d < n : d > n;
    }
    return false;
  });
}

export const reglasDe = (reglas: Regla[], tipo: string) => reglas.filter((r) => r.tipo === tipo);

export const motivosEscalamiento = (reglas: Regla[]): string[] =>
  reglasDe(reglas, "escalamiento").flatMap((r) => {
    const m = r.condicion.toLowerCase().match(/motivo\s*=\s*(.+)$/);
    return m ? m[1].split(",").map((s) => s.trim()) : [];
  });

/** Ventana de horario: lunes a sábado 08:00-20:00. Devuelve null si cumple o el motivo de rechazo. */
export function violaHorario(reglas: Regla[], fechaIso: string, hora: string): string | null {
  const r = reglasDe(reglas, "horario")[0];
  if (!r) return null;
  const dia = DIAS[new Date(`${fechaIso}T12:00:00`).getDay()];
  const m = r.condicion.toLowerCase().match(/(\p{L}+)\s+a\s+(\p{L}+)/u);
  if (m) {
    const i = DIAS.indexOf(m[1] as (typeof DIAS)[number]), j = DIAS.indexOf(m[2] as (typeof DIAS)[number]);
    const d = DIAS.indexOf(dia);
    const rango = i <= j ? d >= i && d <= j : d >= i || d <= j;
    if (!rango) return `${dia} está fuera de "${r.condicion}"`;
  }
  const w = r.valor.match(/(\d{2}):(\d{2})\s*[–-]\s*(\d{2}):(\d{2})/);
  if (w) {
    const t = +hora.slice(0, 2) * 60 + +hora.slice(3, 5);
    if (t < +w[1] * 60 + +w[2] || t > +w[3] * 60 + +w[4]) return `${hora} fuera de ${w[1]}:${w[2]}-${w[3]}:${w[4]}`;
  }
  return null;
}

/** Máximo de días que permite una regla de opción de pago ("... hasta N días"); null si no aplica. */
export const maxDiasOpcion = (r: Regla): number | null => {
  const m = r.valor.toLowerCase().match(/hasta\s+(\d+)\s+d[ií]as/);
  return m ? +m[1] : null;
};

export const palabrasProhibidas = (reglas: Regla[]): string[] =>
  reglasDe(reglas, "lenguaje").flatMap((r) => r.valor.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

export const maxContactosSemana = (reglas: Regla[]): number => {
  const r = reglasDe(reglas, "limite_contacto")[0];
  const m = r?.valor.match(/(\d+)/);
  return m ? +m[1] : 3;
};
