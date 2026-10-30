/** Diagnóstico corto del onboarding. Se califica en el servidor; el becario no ve las claves. */
export const DIAGNOSTIC = {
  math: [
    { id: 'm1', q: 'Si 3x + 5 = 20, ¿cuánto vale x?', options: ['3', '5', '15', '25'], answer: 1 },
    { id: 'm2', q: '¿Cuánto es 3/4 de 80?', options: ['20', '40', '60', '75'], answer: 2 },
    { id: 'm3', q: 'Un pasaje sube de S/ 2.00 a S/ 2.50. ¿En qué porcentaje subió?', options: ['5 %', '20 %', '25 %', '50 %'], answer: 2 },
    { id: 'm4', q: 'Si f(x) = 2x − 1, ¿cuánto es f(4)?', options: ['6', '7', '8', '9'], answer: 1 },
    { id: 'm5', q: '¿Cuál es mayor?', options: ['0.35', '1/3', '0.3', 'Son iguales'], answer: 0 },
  ],
  reading: [
    {
      id: 'r1',
      text: 'La beca cubre la pensión y una subvención mensual, pero exige mantener un promedio aprobatorio cada periodo.',
      q: '¿Qué exige la beca según el texto?',
      options: ['Trabajar medio tiempo', 'Mantener un promedio aprobatorio', 'Vivir en la universidad', 'Pagar la pensión'],
      answer: 1,
    },
    {
      id: 'r2',
      text: 'Aunque llegó con dudas, Marta descubrió que pedir ayuda a tiempo le ahorró semanas de frustración.',
      q: '¿Cuál es la idea principal?',
      options: ['Marta no tenía dudas', 'Pedir ayuda a tiempo sirve', 'La frustración es inevitable', 'Las semanas pasan rápido'],
      answer: 1,
    },
    {
      id: 'r3',
      text: 'El centro de salud atiende de lunes a sábado; los domingos solo emergencias.',
      q: 'Si te sientes mal un domingo sin que sea urgente, ¿qué te conviene?',
      options: ['Ir el domingo', 'Ir el lunes', 'No ir nunca', 'Llamar a la universidad'],
      answer: 1,
    },
  ],
};

export function publicDiagnostic() {
  return {
    math: DIAGNOSTIC.math.map(({ answer: _a, ...q }) => q),
    reading: DIAGNOSTIC.reading.map(({ answer: _a, ...q }) => q),
  };
}

export function scoreDiagnostic(math: number[], reading: number[]) {
  const pct = (qs: { answer: number }[], ans: number[]) => Math.round((100 * qs.filter((q, i) => ans[i] === q.answer).length) / qs.length);
  return { mathScore: pct(DIAGNOSTIC.math, math), readingScore: pct(DIAGNOSTIC.reading, reading) };
}
