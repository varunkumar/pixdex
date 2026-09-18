import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/ollama/generateText';
import type { OllamaClient } from '../src/ollama/client';

describe('generateText', () => {
  it('sends the prompt and returns trimmed content', async () => {
    const chat = vi.fn().mockResolvedValue('  Golden hour, golden coat.  \n');
    const client = { chat } as unknown as OllamaClient;

    const result = await generateText('Write a caption', client);

    expect(result).toBe('Golden hour, golden coat.');
    const [messages] = chat.mock.calls[0];
    expect(messages.some((m: { role: string }) => m.role === 'system')).toBe(true);
    expect(messages.find((m: { role: string }) => m.role === 'user').content).toBe('Write a caption');
  });
});
