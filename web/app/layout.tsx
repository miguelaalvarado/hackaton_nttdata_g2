import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cobrador — cobranza temprana con agentes",
  description: "Prototipo de cobranza temprana con agentes de IA: Analista, Gestor y Supervisor (Hack AI Agents, Perú Tech Week).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <nav className="topnav">
          <b>Cobrador</b>
          <Link href="/">Cartera</Link>
          <Link href="/dashboard">Indicadores y modelo</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
