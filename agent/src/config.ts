import { z } from 'zod';

const configSchema = z.object({
  CLOUDFLARE_API_BASE_URL: z.string().url(),
  INGEST_TOKEN: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.5:27b-mlx'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  ORIGINALS_PORT: z.coerce.number().int().positive().default(8787),
  ORIGINALS_TOKEN: z.string().min(1).optional(),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
