import { normalizeText } from './text';

export type InboundCommand = { type: 'OPT_OUT' } | { type: 'OPT_IN' } | { type: 'MESSAGE'; text: string };

/** Palabras de baja. "BAJA" es la obligatoria; se acepta con o sin tildes, mayúsculas o signos. */
const OPT_OUT_WORDS = ['baja'];
const OPT_IN_WORDS = ['alta'];

/** Interpreta un mensaje entrante. La baja se respeta de inmediato, antes de cualquier otra lógica. */
export function parseInbound(text: string): InboundCommand {
  const n = normalizeText(text);
  if (OPT_OUT_WORDS.includes(n)) return { type: 'OPT_OUT' };
  if (OPT_IN_WORDS.includes(n)) return { type: 'OPT_IN' };
  return { type: 'MESSAGE', text };
}
