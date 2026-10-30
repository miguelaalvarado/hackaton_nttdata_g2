import { detectCrisis, normalizeText } from '@acompana/domain';
import type { AssistantReply, AssistantRequest, LLMProvider, ToolCall } from './types';

const OFF_TOPIC = ['futbol', 'partido', 'receta', 'chiste', 'pelicula', 'serie', 'politica', 'presidente', 'elecciones', 'cripto', 'apuesta', 'horoscopo', 'videojuego', 'hazme la tarea', 'resuelve mi examen'];

/**
 * Proveedor determinista para la demo sin API key. Sigue las mismas reglas que el prompt:
 * alcance limitado, sin regaños, check-ins que terminan en pregunta, datos solo desde herramientas.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async reply(req: AssistantRequest): Promise<AssistantReply> {
    const last = [...req.history].reverse().find((t) => t.role === 'user')?.text ?? '';
    const n = normalizeText(last);
    const calls: ToolCall[] = [];
    const tool = async (name: string, input: Record<string, unknown> = {}) => {
      const call = { name, input };
      calls.push(call);
      return JSON.parse(await req.runTool(call));
    };
    const done = (text: string): AssistantReply => ({ text, toolCalls: calls, refused: false, provider: this.name, model: 'mock-v1' });

    const score = n.match(/^(?:me siento |estoy |un |mi animo es )?([1-5])(?: de 5)?$/)?.[1];
    if (score) {
      await tool('log_mood_checkin', { score: Number(score), note: last });
      return done(
        Number(score) >= 4
          ? `¡Qué bueno leer eso! Gracias por contarme. ¿Hay algo de esta semana en lo que quieras que te ayude a organizarte?`
          : Number(score) === 3
            ? `Gracias por contarme. Una semana regular también cuenta. ¿Qué es lo que más te está pesando ahora?`
            : `Gracias por confiarme cómo estás; no tienes que cargarlo solo/a. Si quieres, le pido a la psicóloga de tu universidad que te escriba. ¿Te parece bien?`,
      );
    }

    if (detectCrisis(last).level === 'MALESTAR') {
      await tool('request_human', { reason: `Malestar expresado: "${last.slice(0, 140)}"`, team: 'PSICOLOGIA' });
      return done(
        'Gracias por contármelo; lo que sientes es válido y es más común de lo que parece en los primeros meses. Le pedí a la psicóloga de tu universidad que te escriba hoy. Mientras tanto, ¿hay algo pequeño que te ayudaría esta tarde?',
      );
    }

    if (OFF_TOPIC.some((k) => n.includes(k))) {
      return done('Eso no lo manejo, pero sí puedo ayudarte con tus clases, tus metas de la semana, trámites de la beca o cómo te sientes. ¿Por cuál empezamos?');
    }

    if (/no (cumpli|pude|llegue|alcance)|me atrase|atrasad|no estudie|falte/.test(n)) {
      const g = await tool('get_weekly_goals');
      const nb = g.nextBlock as { title: string; day: string; isToday: boolean; start: string; minutes: number; topic: string | null } | null;
      const course = g.courses?.find((c: { progress: number }) => c.progress < 1)?.name ?? 'el curso que más te cuesta';
      const step = nb
        ? `Tu siguiente bloque del plan es ${nb.title} ${nb.isToday ? 'hoy' : `el ${nb.day}`} a las ${nb.start} (${nb.minutes} min${nb.topic ? `, tema: ${nb.topic}` : ''}). Si ese horario no te funciona, muévelo a otro hueco del mismo día.`
        : `Propongo algo pequeño: hoy 45 minutos de ${course} y mañana otro bloque igual.`;
      return done(`Gracias por contarlo; pasa y no define tu semestre. Llevas ${g.studyHours} de ${g.studyHoursTarget} horas esta semana. ${step} ¿Te animas?`);
    }

    if (/clase|horario|aula|manana tengo|que tengo|recuerda/.test(n)) {
      const s = await tool('get_schedule', { days: 2 });
      const items = (s.sessions ?? []).slice(0, 3).map((x: { course: string; day: string; time: string; room: string }) => `${x.course} (${x.day} ${x.time}, ${x.room})`);
      return done(items.length ? `Tus próximas clases: ${items.join('; ')}. ¿Quieres que te recuerde alguna?` : 'No encuentro clases en los próximos días. ¿Quieres revisar tu horario completo con tu tutor?');
    }

    if (/deposit|subvencion|pago|constancia|carne|tramite|vivienda|transporte|justific|cuarto|pasaje/.test(n)) {
      const f = await tool('get_procedures_faq', { topic: last });
      return done(f.found ? `${f.answer} ¿Te ayudo con algo más de este trámite?` : 'No tengo esa información oficial. Le pido a tu coordinador que te responda; ¿te parece?');
    }

    if (/como voy|meta|avance|reglas|promedio|tercio|credito|desaprob/.test(n)) {
      const r = await tool('get_rules_status');
      const risky = (r.rules ?? []).filter((x: { status: string }) => x.status === 'EN_RIESGO' || x.status === 'INCUMPLE');
      return done(
        risky.length
          ? `Vas bien en varias cosas. Lo que hay que cuidar: ${risky.map((x: { detail: string }) => x.detail).join(' ')} ¿Armamos juntos un plan para esta semana?`
          : 'Vas cumpliendo todas las reglas de tu cohorte. ¡Sigue así! ¿Quieres revisar tus metas de la semana?',
      );
    }

    return done('¡Hola! Puedo ayudarte con tus clases, tus metas de la semana, trámites de la beca o cómo te sientes. ¿Qué necesitas hoy?');
  }
}
