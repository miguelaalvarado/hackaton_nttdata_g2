import { randomUUID } from 'node:crypto';
import type { MessagingChannel, OutboundMessage, SendResult, StatusEvent } from './channel';

/**
 * Canal simulado con la misma interfaz que WhatsApp. El chat web lee los mensajes desde la BD.
 * Para demostrar reintentos, un texto con "#limite" simula un error transitorio de límite de tasa
 * y "#politica" un rechazo por política (que nunca se reintenta).
 */
export class SimulatorChannel implements MessagingChannel {
  readonly name = 'simulator';
  constructor(private onStatus?: (e: StatusEvent) => void | Promise<void>) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const body = `${msg.text ?? ''} ${msg.template?.params.join(' ') ?? ''}`;
    if (body.includes('#limite')) {
      return { ok: false, error: { code: 'SIM_RATE_LIMIT', class: 'TRANSITORIO', message: 'Límite de tasa simulado' } };
    }
    if (body.includes('#politica')) {
      return { ok: false, error: { code: 'SIM_POLICY', class: 'POLITICA', message: 'Rechazo por política simulado' } };
    }
    const providerMessageId = `sim-${randomUUID()}`;
    if (this.onStatus) {
      const cb = this.onStatus;
      setTimeout(() => void cb({ providerMessageId, status: 'delivered', at: new Date() }), 300);
    }
    return { ok: true, providerMessageId };
  }
}
