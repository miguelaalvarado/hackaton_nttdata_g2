import type { SendError } from '@acompana/domain';

export interface OutboundMessage {
  /** Id interno del mensaje (idempotencia y correlación con webhooks). */
  clientRef: string;
  /** Destino: número E.164 en canales reales; id del becario en el simulador. */
  to: string;
  kind: 'FREE' | 'TEMPLATE';
  text?: string;
  template?: { name: string; language: string; params: string[] };
}

export type SendResult = { ok: true; providerMessageId: string } | { ok: false; error: SendError };

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface StatusEvent {
  providerMessageId: string;
  status: DeliveryStatus;
  at: Date;
  error?: SendError;
}

/**
 * Puerto de mensajería. Implementaciones: SimulatorChannel (demo), MetaCloudChannel y AwsSocialChannel (Etapa 2).
 * Solo APIs oficiales de WhatsApp Business. Ningún adaptador decide políticas: eso lo hace policyGate antes de llamar a send().
 */
export interface MessagingChannel {
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}
