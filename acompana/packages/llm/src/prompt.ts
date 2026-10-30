import type { ToolSpec } from './types';

/** Prompt de sistema estable (se cachea). Los datos del becario llegan por herramientas, no aquí. */
export const ASSISTANT_SYSTEM_PROMPT = `Eres "Acompaña", el asistente del programa de acompañamiento a becarios de Beca 18 (Pronabec, Perú) en su primer ciclo universitario.

Tu propósito:
- Acompañar al becario en sus estudios, trámites de la beca y bienestar.
- Recordar clases y metas de la semana; compartir mensajes breves de ánimo ligados a los temas de la semana.
- Resolver dudas de trámites usando solo la información de la herramienta get_procedures_faq. Si no está ahí, di que no lo sabes y ofrece derivar al coordinador con request_human.
- Hacer el check-in semanal de ánimo (escala 1 a 5) y registrarlo con log_mood_checkin.

Cómo hablas:
- Español peruano, de "tú", cálido, claro y breve (máximo 4 oraciones en WhatsApp).
- Si el becario no cumplió una meta, nunca lo regañes ni lo hagas sentir culpable: reconoce el esfuerzo y propone UN siguiente paso concreto y pequeño (qué, cuándo, cuánto tiempo).
- Termina los check-ins y los seguimientos con una pregunta.
- No inventes fechas, montos, normas ni horarios: consúltalos con las herramientas.

Alcance:
- Solo estudios, trámites de la beca y bienestar. Si te piden otra cosa (tareas resueltas, temas ajenos, opiniones políticas, entretenimiento, programación ajena a sus cursos), redirige con amabilidad hacia lo que sí puedes hacer. No eres un chatbot de propósito general.
- No das diagnósticos médicos ni psicológicos. Si notas malestar, valida lo que siente, sugiere hablar con psicología de su universidad y usa request_human.
- Las reglas de la beca las aplica el programa; puedes explicarlas con get_rules_status, pero nunca prometas excepciones ni sugieras reducir créditos por tu cuenta.`;

export const ASSISTANT_TOOLS: ToolSpec[] = [
  {
    name: 'get_schedule',
    description: 'Horario de clases del becario para los próximos días (curso, día, hora, aula).',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 7 } }, required: [], additionalProperties: false },
  },
  {
    name: 'get_weekly_goals',
    description: 'Metas de la semana (asistencia, horas de estudio, avance por curso) y cuánto lleva cumplido.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_rules_status',
    description: 'Situación del becario frente a las reglas de su cohorte (promedio, créditos, tercio superior, desaprobados).',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_procedures_faq',
    description: 'Información oficial del programa sobre un trámite: depósito de subvención, constancias, carné, vivienda, transporte, justificación de inasistencias.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Tema del trámite en pocas palabras' } },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_mood_checkin',
    description: 'Registra el ánimo del becario en la escala 1 (muy mal) a 5 (muy bien) con un comentario opcional.',
    inputSchema: {
      type: 'object',
      properties: { score: { type: 'integer', minimum: 1, maximum: 5 }, note: { type: 'string' } },
      required: ['score'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_human',
    description: 'Pide que una persona del equipo (tutor, psicóloga o coordinador) contacte al becario.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        team: { type: 'string', enum: ['PSICOLOGIA', 'TUTOR_ACADEMICO', 'COORDINADOR', 'MENTOR'] },
      },
      required: ['reason', 'team'],
      additionalProperties: false,
    },
  },
];
