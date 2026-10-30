import { validateTemplateCatalog } from '@acompana/domain';
import { describe, expect, it } from 'vitest';
import { renderTemplate, SimulatorChannel, TEMPLATES, TEMPLATE_CATALOG } from '../src';

describe('catálogo de plantillas de WhatsApp', () => {
  it('cumple las reglas de categoría (utility solo ligada a clase/trámite/cita; check-ins con pregunta)', () => {
    expect(validateTemplateCatalog(TEMPLATE_CATALOG)).toEqual([]);
  });
  it('toda plantilla indica cómo darse de baja con BAJA', () => {
    for (const t of Object.values(TEMPLATES)) expect(t.body).toContain('BAJA');
  });
  it('renderiza variables', () => {
    expect(renderTemplate(TEMPLATES.recordatorio_clase, ['Ana', 'Cálculo I', '08:00', 'A-201'])).toContain('Cálculo I hoy a las 08:00 en A-201');
  });
});

describe('SimulatorChannel', () => {
  it('envía y simula errores transitorios y de política', async () => {
    const ch = new SimulatorChannel();
    expect((await ch.send({ clientRef: '1', to: 's', kind: 'FREE', text: 'hola' })).ok).toBe(true);
    const lim = await ch.send({ clientRef: '2', to: 's', kind: 'FREE', text: 'x #limite' });
    expect(lim.ok === false && lim.error.class).toBe('TRANSITORIO');
    const pol = await ch.send({ clientRef: '3', to: 's', kind: 'FREE', text: 'x #politica' });
    expect(pol.ok === false && pol.error.class).toBe('POLITICA');
  });
});
