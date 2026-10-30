// Empaqueta la versión navegador en un solo HTML (dist/acompana.html) para publicarla como página.
// Uso: node browser-demo/build.mjs   (antes: npm run db:seed && npm run export:snapshot -w @acompana/db)
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..');
const shims = path.join(here, 'shims');

const aliasPlugin = {
  name: 'acompana-alias',
  setup(b) {
    const map = {
      'next/navigation': path.join(shims, 'next-navigation.ts'),
      'next/link': path.join(shims, 'next-link.tsx'),
      '@/lib/api': path.join(shims, 'api.ts'),
      'node:crypto': path.join(shims, 'node-crypto.ts'),
    };
    b.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/api|node:crypto)$/ }, (a) => ({ path: map[a.path] }));
    b.onResolve({ filter: /^@\// }, async (a) => b.resolve('./' + a.path.slice(2), { resolveDir: web, kind: a.kind }));
    // React llega por CDN (UMD): se toma de los globales.
    b.onResolve({ filter: /^react(-dom\/client|-dom)?$/ }, (a) => ({ path: a.path, namespace: 'global' }));
    b.onLoad({ filter: /.*/, namespace: 'global' }, (a) => ({
      contents: `module.exports = window.${a.path === 'react' ? 'React' : 'ReactDOM'};`,
      loader: 'js',
    }));
  },
};

const result = await build({
  entryPoints: [path.join(here, 'main.tsx')],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.json': 'json' },
  define: { 'process.env.NEXT_PUBLIC_API_URL': '"navegador"', 'process.env.NODE_ENV': '"production"' },
  plugins: [aliasPlugin],
  logLevel: 'warning',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(path.join(web, 'app/globals.css'), 'utf8') + readFileSync(path.join(here, 'extra.css'), 'utf8');

const html = `<title>Acompaña</title>
<meta name="description" content="Demo de Acompaña: prevención del abandono en becarios Beca 18 (datos sintéticos).">
<style>${css}</style>
<div id="root"><p style="padding:16px">Cargando Acompaña…</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>${js}</script>
`;
mkdirSync(path.join(here, 'dist'), { recursive: true });
const out = path.join(here, 'dist', 'acompana.html');
writeFileSync(out, html);
console.log(`${out} (${Math.round(html.length / 1024)} KB)`);
