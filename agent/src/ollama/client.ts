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

  /**
   * `think: false` skips the reasoning phase of thinking models. It cuts a short
   * caption from ~1,400 generated tokens to under 100; leave it unset for tasks
   * that benefit from reasoning (image analysis).
   */
  async chat(messages: OllamaMessage[], options: { think?: boolean } = {}): Promise<string> {
    const response = await this.fetchFn(`${this.config.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.OLLAMA_MODEL, messages, stream: false, think: options.think }),
    });
    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status}`);
    }
    const body = (await response.json()) as { message: { content: string } };
    return body.message.content;
  }
}
