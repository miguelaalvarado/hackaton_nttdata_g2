import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { trainSyntheticModel } from '../src/risk/training';

const model = trainSyntheticModel();
const out = fileURLToPath(new URL('../src/risk/model.json', import.meta.url));
writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
console.log(`Modelo ${model.version} guardado en ${out}`);
console.log(model.metrics);
console.log(Object.fromEntries(model.features.map((f, i) => [f, +model.coef[i].toFixed(3)])));
