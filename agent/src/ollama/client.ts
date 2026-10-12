import type { AgentConfig } from '../config';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export class OllamaClient {
  constructor(
    private config: AgentConfig,
    private fetchFn: typeof fetch = fetch
  ) {}

  /** `format` is a JSON schema; Ollama constrains the reply to match it. */
  async chat(messages: OllamaMessage[], options: { format?: object } = {}): Promise<string> {
    const response = await this.fetchFn(`${this.config.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.OLLAMA_MODEL, messages, stream: false, format: options.format }),
    });
    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status}`);
    }
    const body = (await response.json()) as { message: { content: string } };
    return body.message.content;
  }
}
