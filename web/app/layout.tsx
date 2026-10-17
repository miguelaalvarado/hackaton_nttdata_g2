import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cobrador — cobranza temprana con agentes",
  description: "Prototipo de cobranza temprana adaptativa con agentes de IA (Hack AI Agents, Perú Tech Week).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
