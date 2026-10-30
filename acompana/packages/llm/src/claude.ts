import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { AssistantReply, AssistantRequest, LLMProvider, ToolCall } from './types';


type MessagesClient = { beta: { messages: Pick<Anthropic['beta']['messages'], 'create'> } };

const MAX_TOOL_ROUNDS = 4;
/** Respuesta segura si el modelo declina o falla: nunca se deja al becario sin respuesta. */
const SAFE_TEXT =
  'Ahora no puedo responder eso. Puedo ayudarte con tus estudios, trámites de la beca o cómo te sientes. ¿Con cuál te ayudo?';

/**
 * Asistente sobre Claude (Messages API, bucle manual de herramientas).
 * Mismo código para la API de Anthropic y para Amazon Bedrock (cliente Mantle); solo cambia el cliente.
 */
export class ClaudeProvider implements LLMProvider {
  constructor(
    readonly name: 'anthropic' | 'bedrock',
    private client: MessagesClient,
    private model: string,
    private opts: { effort: 'low' | 'medium' | 'high'; serverFallbacks: boolean },
  ) {}

  async reply(req: AssistantRequest): Promise<AssistantReply> {
    const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = req.history.map((t) => ({ role: t.role, content: t.text }));
    const toolCalls: ToolCall[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: this.opts.effort },
        tools,
        messages,
        // Reintento del lado del servidor ante una negativa por categoría de seguridad (solo API de Anthropic).
        ...(this.opts.serverFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });

      if (response.stop_reason === 'refusal') {
        return { text: SAFE_TEXT, toolCalls, refused: true, provider: this.name, model: response.model };
      }

      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || uses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return { text: text || SAFE_TEXT, toolCalls, refused: false, provider: this.name, model: response.model };
      }

      messages.push({ role: 'assistant', content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
        uses.map(async (u) => {
          const call = { name: u.name, input: (u.input ?? {}) as Record<string, unknown> };
          toolCalls.push(call);
          try {
            return { type: 'tool_result' as const, tool_use_id: u.id, content: await req.runTool(call) };
          } catch (e) {
            return { type: 'tool_result' as const, tool_use_id: u.id, content: String(e), is_error: true };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    return { text: SAFE_TEXT, toolCalls, refused: false, provider: this.name, model: this.model };
  }
}

export function anthropicProvider(model: string): ClaudeProvider {
  return new ClaudeProvider('anthropic', new Anthropic(), model, { effort: 'low', serverFallbacks: true });
}

/** Bedrock: el modelo lleva el prefijo "anthropic." y la región es obligatoria. Sin fallbacks del servidor en Bedrock. */
export function bedrockProvider(model: string, awsRegion: string): ClaudeProvider {
  return new ClaudeProvider('bedrock', new AnthropicBedrockMantle({ awsRegion }), model, { effort: 'low', serverFallbacks: false });
}
