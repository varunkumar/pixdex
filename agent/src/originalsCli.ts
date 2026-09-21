import { createOriginalsServer } from './originals/server';
import type { AgentConfig } from './config';

export interface RunServeOriginalsDeps {
  createServer?: typeof createOriginalsServer;
}

export function runServeOriginals(config: AgentConfig, deps: RunServeOriginalsDeps = {}): number {
  if (!config.ORIGINALS_TOKEN) {
    console.error('ORIGINALS_TOKEN must be set to run serve-originals');
    return 1;
  }

  const { createServer = createOriginalsServer } = deps;
  const server = createServer(config);

  server.listen(config.ORIGINALS_PORT, () => {
    console.log(`Serving indexed local-disk originals on http://localhost:${config.ORIGINALS_PORT}`);
    console.log('Run "cloudflared tunnel --config agent/cloudflared/config.yml run pixdex-originals" separately to expose it.');
  });

  return 0;
}
