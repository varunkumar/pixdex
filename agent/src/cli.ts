import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { loadConfig } from './config';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import { indexLocalFolder } from './indexLocalFolder';
import { runIndexDrive } from './driveCli';
import { runServeOriginals } from './originalsCli';
import { backfillRatings } from './backfillRatings';
import { backfillExif } from './backfillExif';
import { backfillFaces } from './backfillFaces';
import { createFaceSidecar } from './faces/sidecarClient';
import fs from 'node:fs/promises';
import { buildGallery } from './known/buildGallery';
import { GALLERY_PATH, loadGallery, saveGallery, type KnownPerson } from './known/gallery';
import { WikimediaClient } from './known/wikimedia';
import { runIndexBatch, runIndexStatus } from './batch/cli';

const UPSERT_BATCH = 500;
const PeopleSchema = z.array(z.object({ id: z.string().min(1), name: z.string().min(1), aliases: z.array(z.string()) }));
const PEOPLE_PATH = fileURLToPath(new URL('../known/people.json', import.meta.url));

async function runBuildKnownGallery(args: string[]): Promise<number> {
  try {
    const full = args.includes('--full');
    const rebuild: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--rebuild') continue;
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) rebuild.push(args[++i]);
    }
    const config = loadConfig();
    const sidecar = createFaceSidecar(config);
    if (!sidecar) {
      console.error('Error: FACE_SIDECAR_URL is not set (start the sidecar, see agent/sidecar/README.md)');
      return 1;
    }
    const people = PeopleSchema.parse(JSON.parse(await fs.readFile(PEOPLE_PATH, 'utf8'))) as KnownPerson[];
    const existing = full ? undefined : await loadGallery(GALLERY_PATH);
    const { gallery, report } = await buildGallery({
      people,
      existing,
      rebuild,
      wikimedia: new WikimediaClient(),
      sidecar,
      download: async (url) => {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'face-gallery-builder/0.1' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`download failed: ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      },
      onProgress: (message) => console.log(message),
      onCheckpoint: (g) => saveGallery(GALLERY_PATH, g),
    });
    await saveGallery(GALLERY_PATH, gallery);
    const client = new CloudflareClient(config);
    const included = gallery.people.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases }));
    let upserted = 0;
    for (let i = 0; i < included.length; i += UPSERT_BATCH) {
      upserted += await client.upsertKnownPeople(included.slice(i, i + UPSERT_BATCH));
    }
    console.log(
      `Gallery saved: ${report.included.length} people included, ${report.excluded.length} excluded, average refs per person ${report.averageRefs.toFixed(1)}, upserted ${upserted}`
    );
    if (report.failed.length > 0) {
      console.log(`Failed on Wikimedia errors (not stored, retried next run): ${report.failed.length}`);
      for (const p of report.failed) console.log(`  ${p.id} ${p.name}: ${p.error}`);
    }
    if (report.excluded.length > 0) {
      console.log('Excluded (fewer than 3 usable openly licensed photos):');
      for (const p of report.excluded) console.log(`  ${p.id} ${p.name} (${p.refs})`);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, folder] = argv;

  if (command === 'serve-originals') {
    return runServeOriginals(loadConfig());
  }

  if (command === 'index-batch') {
    return runIndexBatch(loadConfig(), argv.slice(1));
  }

  if (command === 'build-known-gallery') {
    return runBuildKnownGallery(argv.slice(1));
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

  if (command === 'backfill-faces') {
    const faceArgs = argv.slice(1);
    const missingCrops = faceArgs.includes('--recrop');
    const faceFolder = faceArgs.find((a) => !a.startsWith('--'));
    try {
      const config = loadConfig();
      const sidecar = createFaceSidecar(config);
      if (!sidecar) {
        console.error('Error: FACE_SIDECAR_URL is not set (start the sidecar, see agent/sidecar/README.md)');
        return 1;
      }
      const result = await backfillFaces({
        cloudflareClient: new CloudflareClient(config),
        sidecar,
        // A trailing separator keeps "Processed" from also matching "Processed 2".
        pathPrefix: faceFolder ? path.join(path.resolve(faceFolder), path.sep) : undefined,
        missingCrops,
        onProgress: (message) => console.log(message),
      });
      console.log(
        `Done. Unscanned: ${result.total}, Scanned: ${result.scanned}, Faces: ${result.faces}, File missing: ${result.missing}, Not indexed: ${result.notIndexed}, Failed: ${result.failed}`
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
      'Usage: pixdex-agent index-local <folder>\n       pixdex-agent backfill-exif <folder>\n       pixdex-agent backfill-ratings <folder>\n       pixdex-agent backfill-faces [folder] [--recrop]\n       pixdex-agent index-batch <root-or-album>...\n       pixdex-agent index-status\n       pixdex-agent build-known-gallery [--rebuild <id>...] [--full]\n       pixdex-agent index-drive\n       pixdex-agent serve-originals'
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
      faceSidecar: createFaceSidecar(config),
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
