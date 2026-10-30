import { anthropicProvider, bedrockProvider } from './claude';
import { MockProvider } from './mock';
import type { LLMProvider } from './types';

export * from './types';
export * from './prompt';
export { ClaudeProvider } from './claude';
export { MockProvider } from './mock';

/**
 * Elige el proveedor por variables de entorno:
 * LLM_PROVIDER=anthropic (requiere ANTHROPIC_API_KEY) | bedrock (requiere AWS_REGION y credenciales AWS) | mock (por defecto).
 */
export function createLLMProvider(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const kind = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock');
  if (kind === 'anthropic') return anthropicProvider(env.LLM_MODEL ?? 'claude-opus-5-5');
  if (kind === 'bedrock') {
    if (!env.AWS_REGION) throw new Error('LLM_PROVIDER=bedrock requiere AWS_REGION');
    return bedrockProvider(env.BEDROCK_MODEL ?? 'anthropic.claude-opus-5-5', env.AWS_REGION);
  }
  return new MockProvider();
}
