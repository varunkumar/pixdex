import { loadConfig } from './config';
import { CloudflareClient } from './cloudflareClient';
import { moveAlbum } from './moveAlbum';

const USAGE = 'Usage: npm run move-album -- <from-folder> <to-folder> [--dry-run] [--index-only]';

export async function runMoveAlbum(argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith('--'));
  const [from, to, ...extra] = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--dry-run' && f !== '--index-only');
  if (!from || !to || extra.length > 0 || unknown.length > 0) {
    console.error(USAGE);
    return 1;
  }

  try {
    const result = await moveAlbum(
      from,
      to,
      { cloudflareClient: new CloudflareClient(loadConfig()) },
      {
        dryRun: flags.includes('--dry-run'),
        indexOnly: flags.includes('--index-only'),
        onProgress: (message) => console.log(message),
      }
    );
    console.log(`Done. Indexed photos: ${result.photos}, Files copied across volumes: ${result.files}`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runMoveAlbum(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
