/** Puerto del asistente. Las apps dependen de esta interfaz, nunca de un proveedor concreto. */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema del input (objeto). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface AssistantRequest {
  system: string;
  history: ChatTurn[];
  tools: ToolSpec[];
  /** Ejecuta una herramienta y devuelve su resultado como texto (JSON). */
  runTool: (call: ToolCall) => Promise<string>;
}

export interface AssistantReply {
  text: string;
  toolCalls: ToolCall[];
  /** El proveedor declinó responder (p. ej. stop_reason "refusal"). */
  refused: boolean;
  provider: string;
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  reply(req: AssistantRequest): Promise<AssistantReply>;
}
