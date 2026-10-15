import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import { indexLocalFolder } from './indexLocalFolder';
import { runIndexDrive } from './driveCli';
import { runServeOriginals } from './originalsCli';
import { backfillRatings } from './backfillRatings';
import { backfillExif } from './backfillExif';
import { runIndexBatch, runIndexStatus } from './batch/cli';

export async function runCli(argv: string[]): Promise<number> {
  const [command, folder] = argv;

  if (command === 'serve-originals') {
    return runServeOriginals(loadConfig());
  }

  if (command === 'index-batch') {
    return runIndexBatch(loadConfig(), argv.slice(1));
  }

  if (command === 'index-status') {
    return runIndexStatus(argv.slice(1));
  }

  if (command === 'index-drive') {
    const config = loadConfig();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await runIndexDrive(config, { prompt: (question) => rl.question(question) });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    } finally {
      rl.close();
    }
  }

  if (command === 'backfill-exif' && folder) {
    try {
      const result = await backfillExif(folder, {
        cloudflareClient: new CloudflareClient(loadConfig()),
        onProgress: (message) => console.log(message),
      });
      console.log(
        `Done. Total: ${result.total}, Updated: ${result.updated}, Not indexed: ${result.notIndexed}, Failed: ${result.failed}`
      );
      return result.failed > 0 ? 1 : 0;
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (command === 'backfill-ratings' && folder) {
    try {
      const config = loadConfig();
      const result = await backfillRatings(folder, {
        cloudflareClient: new CloudflareClient(config),
        ollamaClient: new OllamaClient(config),
        onProgress: (message) => console.log(message),
      });
      console.log(
        `Done. Total: ${result.total}, Rated: ${result.rated}, Not indexed: ${result.notIndexed}, Nothing usable: ${result.unrated}, Failed: ${result.failed}`
      );
      return result.failed > 0 ? 1 : 0;
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (command !== 'index-local' || !folder) {
    console.error(
      'Usage: pixdex-agent index-local <folder>\n       pixdex-agent backfill-exif <folder>\n       pixdex-agent backfill-ratings <folder>\n       pixdex-agent index-batch <root-or-album>...\n       pixdex-agent index-status\n       pixdex-agent index-drive\n       pixdex-agent serve-originals'
    );
    return 1;
  }

  const config = loadConfig();
  const cloudflareClient = new CloudflareClient(config);
  const ollamaClient = new OllamaClient(config);

  try {
    const result = await indexLocalFolder(folder, {
      cloudflareClient,
      ollamaClient,
      config,
      onProgress: (message) => console.log(message),
    });

    console.log(
      `Done. Total: ${result.total}, Indexed: ${result.indexed}, Skipped: ${result.skipped}, Failed: ${result.failed}`
    );
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
