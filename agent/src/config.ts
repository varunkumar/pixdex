import { z } from 'zod';

const configSchema = z.object({
  CLOUDFLARE_API_BASE_URL: z.string().url(),
  INGEST_TOKEN: z.string().min(1),
  READ_TOKEN: z.string().min(1).optional(),
  // The album owner's email. Sent as ownerEmail on every ingested photo (the first photo of an album
  // stamps its owner) and as X-Viewer-Email on originals and index-status Worker reads. The Worker
  // never reads it from its own environment: it lives only here.
  OWNER_EMAIL: z.string().trim().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.5:27b-mlx'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  // Drive indexing stages one photo at a time in a temp folder; a photo bigger than this many MB is refused
  // before download. Unset means 1024 (1 GB).
  DRIVE_STAGING_MAX_MB: z.coerce.number().positive().optional(),
  ORIGINALS_PORT: z.coerce.number().int().positive().default(8787),
  ORIGINALS_TOKEN: z.string().min(1).optional(),
  FACE_SIDECAR_URL: z
    .string()
    .url()
    .refine((value) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname), {
      message: 'FACE_SIDECAR_URL must point at a loopback host (127.0.0.1, localhost or [::1])',
    })
    .optional(),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
