/** Regresión logística mínima (descenso de gradiente con regularización L2) sobre variables estandarizadas. */

export interface LogisticModel {
  version: string;
  features: string[];
  means: number[];
  stds: number[];
  coef: number[];
  intercept: number;
  metrics?: { n: number; positiveRate: number; auc: number; trainedOn: string };
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function standardize(x: number[], means: number[], stds: number[]): number[] {
  return x.map((v, i) => (v - means[i]) / (stds[i] || 1));
}

export function predictProba(model: LogisticModel, x: number[]): number {
  const z = standardize(x, model.means, model.stds);
  return sigmoid(model.intercept + z.reduce((s, v, i) => s + v * model.coef[i], 0));
}

/** Aporte de cada variable al logit (coef × valor estandarizado). Positivo = sube el riesgo. */
export function contributions(model: LogisticModel, x: number[]): { feature: string; value: number; contribution: number }[] {
  const z = standardize(x, model.means, model.stds);
  return model.features.map((feature, i) => ({ feature, value: x[i], contribution: z[i] * model.coef[i] }));
}

export function train(
  features: string[],
  X: number[][],
  y: number[],
  opts: { epochs?: number; lr?: number; l2?: number; version: string; trainedOn: string },
): LogisticModel {
  const { epochs = 2000, lr = 0.1, l2 = 0.001 } = opts;
  const n = X.length;
  const d = features.length;
  const means = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const stds = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - means[j]) ** 2, 0) / n) || 1);
  const Z = X.map((r) => standardize(r, means, stds));
  const coef = new Array(d).fill(0);
  let intercept = 0;
  for (let e = 0; e < epochs; e++) {
    const gW = new Array(d).fill(0);
    let gB = 0;
    for (let i = 0; i < n; i++) {
      const err = sigmoid(intercept + Z[i].reduce((s, v, j) => s + v * coef[j], 0)) - y[i];
      gB += err;
      for (let j = 0; j < d; j++) gW[j] += err * Z[i][j];
    }
    intercept -= (lr * gB) / n;
    for (let j = 0; j < d; j++) coef[j] -= lr * (gW[j] / n + l2 * coef[j]);
  }
  const model: LogisticModel = { version: opts.version, features, means, stds, coef, intercept };
  const scores = X.map((r) => predictProba(model, r));
  model.metrics = { n, positiveRate: y.reduce((a, b) => a + b, 0) / n, auc: auc(scores, y), trainedOn: opts.trainedOn };
  return model;
}

/** AUC por comparación de pares (Mann-Whitney). */
export function auc(scores: number[], y: number[]): number {
  const pos = scores.filter((_, i) => y[i] === 1);
  const neg = scores.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
