import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '../config';
import { CloudflareClient } from '../cloudflareClient';
import { OllamaClient } from '../ollama/client';
import { indexLocalFolder } from '../indexLocalFolder';
import { runBatch } from './runBatch';
import { formatStatus, summarize } from './status';
import { loadState } from './state';

// Wildlife albums first; everything else alphabetically afterwards.
const DEFAULT_PRIORITY = [/bandipur|nagarhole|bird watching|pulicat/i];

export function stateDirectory(env: Record<string, string | undefined> = process.env): string {
  if (env.PIXDEX_STATE_DIR) return env.PIXDEX_STATE_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.index-state');
}

interface ParsedArgs {
  inputs: string[];
  priority: RegExp[];
  retryFailed: boolean;
  json: boolean;
}

export function parseBatchArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { inputs: [], priority: DEFAULT_PRIORITY, retryFailed: false, json: false };
  for (const arg of args) {
    if (arg === '--retry-failed') parsed.retryFailed = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg.startsWith('--priority=')) {
      parsed.priority = arg
        .slice('--priority='.length)
        .split(',')
        .filter(Boolean)
        .map((pattern) => new RegExp(pattern, 'i'));
    } else if (!arg.startsWith('--')) parsed.inputs.push(arg);
  }
  return parsed;
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runIndexBatch(config: AgentConfig, args: string[]): Promise<number> {
  const { inputs, priority, retryFailed } = parseBatchArgs(args);
  if (inputs.length === 0) {
    console.error('Usage: pixdex-agent index-batch [--priority=regex[,regex]] [--retry-failed] <root-or-album-folder>...');
    return 1;
  }

  const dir = stateDirectory();
  const cloudflareClient = new CloudflareClient(config);
  const ollamaClient = new OllamaClient(config);
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  const stop = () => process.exit(130);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const result = await runBatch(
      { inputs, priority, retryFailed, stateFile: path.join(dir, 'queue.json'), lockFile: path.join(dir, 'batch.lock') },
      {
        indexFolder: (folder, hooks) =>
          indexLocalFolder(folder, { cloudflareClient, ollamaClient, config, ...hooks }),
        checkHealth: async () => {
          if (!(await probe(`${config.OLLAMA_BASE_URL}/api/tags`))) return `Ollama is not reachable at ${config.OLLAMA_BASE_URL}`;
          if (!(await probe(`${config.CLOUDFLARE_API_BASE_URL}/health`))) return 'the Worker is not reachable';
          return null;
        },
        log: (message) => console.log(`[${stamp()}] ${message}`),
      }
    );
    return result.exitCode;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runIndexStatus(args: string[]): Promise<number> {
  const { json } = parseBatchArgs(args);
  const { state } = await loadState(path.join(stateDirectory(), 'queue.json'));
  if (Object.keys(state.albums).length === 0) {
    console.log('No batch has been started yet. Run: npm run dev -- index-batch <folder>...');
    return 0;
  }
  console.log(json ? JSON.stringify({ summary: summarize(state), state }, null, 2) : formatStatus(state));
  return 0;
}
