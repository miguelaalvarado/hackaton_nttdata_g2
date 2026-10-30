'use client';
import { useSession } from '@/components/useSession';
import { Chat } from '@/components/Chat';

export default function BecarioChat() {
  const user = useSession(['BECARIO']);
  if (!user?.scholarId) return null;
  return (
    <>
      <h1>WhatsApp (simulador)</h1>
      <p className="small muted">
        Mismo flujo que el canal oficial de WhatsApp Business. Escribe <strong>BAJA</strong> para dejar de recibir mensajes o <strong>ALTA</strong> para volver.
      </p>
      <Chat scholarId={user.scholarId} canWrite />
    </>
  );
}
