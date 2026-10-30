import { normalizeText } from './text';

export type CrisisLevel = 'NINGUNO' | 'MALESTAR' | 'CRISIS';

/**
 * Frases revisables por el equipo de psicología. Se comparan sin tildes ni mayúsculas.
 * La detección corre ANTES del LLM: ante crisis, el asistente no responde por su cuenta.
 */
export const CRISIS_PATTERNS = [
  'quiero morir',
  'me quiero morir',
  'quisiera morir',
  'me quiero matar',
  'matarme',
  'suicid',
  'quitarme la vida',
  'no quiero vivir',
  'no quiero seguir viviendo',
  'hacerme dano',
  'lastimarme',
  'acabar con todo',
  'mejor desaparecer',
  'desaparecer para siempre',
  'no vale la pena vivir',
  'mejor muerta',
  'mejor muerto',
];

export const DISTRESS_PATTERNS = [
  'no puedo mas',
  'me siento sola',
  'me siento solo',
  'muy sola',
  'muy solo',
  'estoy triste',
  'muy triste',
  'ansiedad',
  'ansiosa',
  'ansioso',
  'no duermo',
  'no puedo dormir',
  'llorando',
  'lloro',
  'deprimid',
  'agobiad',
  'angustia',
  'sin ganas',
  'no tengo ganas',
  'extrano a mi familia',
];

export interface CrisisResult {
  level: CrisisLevel;
  matches: string[];
}

export function detectCrisis(text: string): CrisisResult {
  const n = normalizeText(text);
  const crisis = CRISIS_PATTERNS.filter((p) => n.includes(p));
  if (crisis.length) return { level: 'CRISIS', matches: crisis };
  const distress = DISTRESS_PATTERNS.filter((p) => n.includes(p));
  if (distress.length) return { level: 'MALESTAR', matches: distress };
  return { level: 'NINGUNO', matches: [] };
}
