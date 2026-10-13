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

  it('skips the thinking phase, which is slow and pointless for a short caption', async () => {
    const chat = vi.fn().mockResolvedValue('Caption');
    await generateText('Write a caption', { chat } as unknown as OllamaClient);
    expect(chat.mock.calls[0][1]).toEqual({ think: false });
  });
});

describe('OllamaClient think option', () => {
  const config = { OLLAMA_BASE_URL: 'http://localhost:11434', OLLAMA_MODEL: 'm' } as never;
  const reply = () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });

  it('sends think only when asked, so image analysis keeps its default', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => reply());
    const client = new (await import('../src/ollama/client')).OllamaClient(config, fetchFn as unknown as typeof fetch);

    await client.chat([{ role: 'user', content: 'a' }], { think: false });
    await client.chat([{ role: 'user', content: 'b' }]);

    expect(JSON.parse(fetchFn.mock.calls[0][1].body).think).toBe(false);
    expect('think' in JSON.parse(fetchFn.mock.calls[1][1].body)).toBe(false);
  });
});
