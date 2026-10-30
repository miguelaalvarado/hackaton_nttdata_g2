import { createRng } from '../random';
import { sampleLatent, sampleOutcome, sampleWeek } from '../synthetic';
import { RISK_FEATURES, toFeatureVector } from './features';
import { train, type LogisticModel } from './logistic';

/** Entrena el modelo de riesgo con becarios sintéticos (señales de la semana 6 → resultado al fin del ciclo). */
export function trainSyntheticModel(n = 2000, seed = 2026): LogisticModel {
  const rng = createRng(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = sampleLatent(rng);
    const failed = rng.chance(Math.max(0, 0.45 - 0.6 * l.academic)) ? 1 : 0;
    X.push(toFeatureVector(sampleWeek(l, 6, rng, failed)));
    y.push(sampleOutcome(l, failed, rng));
  }
  return train([...RISK_FEATURES], X, y, { version: `logit-sintetico-v1-n${n}`, trainedOn: 'datos sintéticos (src/synthetic.ts)' });
}
