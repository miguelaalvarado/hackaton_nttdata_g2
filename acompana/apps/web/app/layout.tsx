import './globals.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Acompaña',
  description: 'Acompañamiento a becarios en su primer ciclo (demo con datos sintéticos).',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };
// Se renderiza en cada petición para leer API_PUBLIC_URL en tiempo de ejecución (misma imagen en cualquier nube).
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const apiUrl = process.env.API_PUBLIC_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  return (
    <html lang="es-PE">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `window.__ACOMPANA_API__=${JSON.stringify(apiUrl)};` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
