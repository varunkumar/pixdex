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
import { backfillKnown } from './backfillKnown';
import { loadKnownGallery } from './known/loadKnownGallery';
import { createFaceSidecar } from './faces/sidecarClient';
import fs from 'node:fs/promises';
import { buildGallery } from './known/buildGallery';
import { GALLERY_PATH, loadGallery, saveGallery, type KnownPerson } from './known/gallery';
import { WikimediaClient } from './known/wikimedia';
import { checkList, entityProblems, fetchCandidates, loadList, PersonSchema, saveList, searchWikidata } from './known/list';
import { runIndexBatch, runIndexStatus } from './batch/cli';

const UPSERT_BATCH = 500;
const PeopleSchema = z.array(PersonSchema);
const DEFAULT_PEOPLE_PATH = fileURLToPath(new URL('../known/people.json', import.meta.url));
const peoplePath = () => process.env.KNOWN_PEOPLE_PATH || DEFAULT_PEOPLE_PATH;

async function runBuildKnownGallery(args: string[]): Promise<number> {
  try {
    const full = args.includes('--full');
    const retryExcluded = args.includes('--retry-excluded');
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
    const people = PeopleSchema.parse(JSON.parse(await fs.readFile(peoplePath(), 'utf8'))) as KnownPerson[];
    const existing = full ? undefined : await loadGallery(GALLERY_PATH);
    const { gallery, report } = await buildGallery({
      people,
      existing,
      rebuild,
      retryExcluded,
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

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) values.push(args[++i]);
  }
  return values;
}

async function runKnownSearch(args: string[]): Promise<number> {
  const query = args.join(' ').trim();
  if (!query) {
    console.error('Usage: pixdex-agent known-search "<name>"');
    return 1;
  }
  try {
    const candidates = await searchWikidata(query, {});
    if (candidates.length === 0) console.log('No candidates.');
    for (const c of candidates) {
      const flags = [c.isHuman ? 'human' : 'NOT HUMAN', c.hasPortrait ? 'portrait' : '', c.hasCategory ? 'category' : '']
        .filter(Boolean)
        .join(', ');
      console.log(`${c.id}  ${c.label}  (${c.description}) sitelinks ${c.sitelinks} [${flags}]`);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runKnownAdd(args: string[]): Promise<number> {
  try {
    const id = flagValues(args, '--id')[0];
    if (!id || !/^Q\d+$/.test(id)) {
      console.error('Usage: pixdex-agent known-add --id <Q...> [--name "<display name>"] [--alias <a>]...');
      return 1;
    }
    const file = peoplePath();
    const people = await loadList(file);
    if (people.some((p) => p.id === id)) {
      console.error(`Error: ${id} is already in the list`);
      return 1;
    }
    const candidate = (await fetchCandidates([id], {})).get(id);
    const name = flagValues(args, '--name')[0] ?? candidate?.label ?? '';
    const aliases = flagValues(args, '--alias');
    const entry = { id, name, aliases };
    const lowerName = name.trim().toLowerCase();
    const problems = [
      ...entityProblems(entry, candidate),
      ...(people.some((p) => p.name.trim().toLowerCase() === lowerName) ? ['duplicate name'] : []),
      ...(aliases.some((a) => a.trim().toLowerCase() === lowerName) ? ['alias equals the name'] : []),
    ];
    if (!name) problems.push('no name (pass --name)');
    if (problems.length > 0) {
      console.error(`Error: refusing to add ${id} ${name}: ${problems.join('; ')}`);
      return 1;
    }
    await saveList(file, [...people, entry]);
    console.log(`Added ${id} ${name}`);
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runKnownCheck(args: string[]): Promise<number> {
  try {
    const people = await loadList(peoplePath());
    const issues = await checkList(people, { online: !args.includes('--offline') });
    for (const i of issues) console.log(`${i.id} ${i.name}: ${i.problem}`);
    console.log(issues.length === 0 ? `OK: ${people.length} people, no issues` : `${issues.length} issue(s)`);
    return issues.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runBackfillKnown(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const rescore = args.includes('--rescore');
  let pageSize: number | undefined;
  const sizeIdx = args.indexOf('--page-size');
  if (sizeIdx !== -1) {
    const raw = args[sizeIdx + 1];
    pageSize = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      console.error('Error: --page-size must be an integer from 1 to 100');
      return 1;
    }
  }
  try {
    const gallery = await loadGallery(GALLERY_PATH);
    if (!gallery) {
      console.error('Error: no known gallery found; run build-known-gallery first');
      return 1;
    }
    // The gallery was built with the sidecar's model, which is also what the Worker stores embeddings under,
    // so the sidecar does not need to be running.
    const result = await backfillKnown({
      cloudflareClient: new CloudflareClient(loadConfig()),
      gallery,
      model: gallery.model,
      dryRun,
      rescore,
      ...(pageSize !== undefined ? { pageSize } : {}),
      onProgress: (message) => console.log(message),
    });
    console.log(
      `Done. Scanned: ${result.scanned}, Matched: ${result.matched}, Cleared: ${result.cleared}, Skipped (bad embedding): ${result.skipped}, Changed (rows written): ${result.written}`
    );
    if (result.scanned === 0) {
      console.log(
        `No faces were found for model "${gallery.model}". If faces exist, they were scanned with a different model: rebuild the gallery with build-known-gallery --full.`
      );
    }
    console.log('Top people:');
    for (const p of result.perPerson.slice(0, 20)) console.log(`  ${p.name} (${p.id}): ${p.count}`);
    console.log('Score histogram (0.05 buckets):');
    for (const key of Object.keys(result.scoreBuckets).sort()) console.log(`  ${key}: ${result.scoreBuckets[key]}`);
    console.log('Samples:');
    for (const s of result.samples) console.log(`  face ${s.faceId} -> ${s.knownId} (${s.score.toFixed(3)})`);
    if (dryRun) console.log('Dry run: nothing was written.');
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

  if (command === 'backfill-known') return runBackfillKnown(argv.slice(1));
  if (command === 'known-search') return runKnownSearch(argv.slice(1));
  if (command === 'known-add') return runKnownAdd(argv.slice(1));
  if (command === 'known-check') return runKnownCheck(argv.slice(1));

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
        gallery: await loadKnownGallery(),
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
      'Usage: pixdex-agent index-local <folder>\n       pixdex-agent backfill-exif <folder>\n       pixdex-agent backfill-ratings <folder>\n       pixdex-agent backfill-faces [folder] [--recrop]\n       pixdex-agent index-batch <root-or-album>...\n       pixdex-agent index-status\n       pixdex-agent build-known-gallery [--rebuild <id>...] [--retry-excluded] [--full]\n       pixdex-agent backfill-known [--dry-run] [--rescore] [--page-size <n>]\n       pixdex-agent known-search "<name>"\n       pixdex-agent known-add --id <Q...> [--name <n>] [--alias <a>]...\n       pixdex-agent known-check [--offline]\n       pixdex-agent index-drive\n       pixdex-agent serve-originals'
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
      knownGallery: await loadKnownGallery(),
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
