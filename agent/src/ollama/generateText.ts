import type { OllamaClient } from './client';

export async function generateText(prompt: string, client: OllamaClient): Promise<string> {
  const content = await client.chat([
    {
      role: 'system',
      content: 'You are a wildlife photography expert writing engaging, accurate Instagram content.',
    },
    { role: 'user', content: prompt },
  ]);
  return content.trim();
}
