import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillSpecies } from './backfillSpecies';
import { CloudflareClient } from './cloudflareClient';
import { loadConfig, type AgentConfig } from './config';
import { parseSpeciesArgs } from './species/args';
import { createDriveReader } from './species/driveReader';
import type { SpeciesDeps } from './species/identify';
import { buildRegionFile, loadRegionsConfig, type RegionsConfig } from './species/regions';
import { createSpeciesSidecar, type SpeciesSidecarClient } from './species/sidecarClient';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The committed region definitions (override with SPECIES_REGIONS_FILE). */
const regionsFile = () => process.env.SPECIES_REGIONS_FILE || path.resolve(HERE, '../species/regions.json');
/** Species lists built from GBIF, local and uncommitted; the species sidecar reads the same folder. */
export const REGIONS_DIR = path.resolve(HERE, '../.index-state/species-regions');

/** Species identification for newly indexed photos: undefined (off) unless SPECIES_SIDECAR_URL is set. */
export async function createSpeciesDeps(config: AgentConfig): Promise<SpeciesDeps | undefined> {
  const sidecar = createSpeciesSidecar(config);
  return sidecar ? { sidecar, regions: await loadRegionsConfig(regionsFile()) } : undefined;
}

export interface BackfillSpeciesCliDeps {
  config: AgentConfig;
  cloudflareClient: Pick<CloudflareClient, 'speciesSummary' | 'speciesPending' | 'ingestSpecies'>;
  sidecar: Pick<SpeciesSidecarClient, 'model' | 'identify'> | undefined;
  regions: RegionsConfig;
  backfill: typeof backfillSpecies;
  createDriveReader: typeof createDriveReader;
}

async function defaultDeps(): Promise<BackfillSpeciesCliDeps> {
  const config = loadConfig();
  return {
    config,
    cloudflareClient: new CloudflareClient(config),
    sidecar: createSpeciesSidecar(config),
    regions: await loadRegionsConfig(regionsFile()),
    backfill: backfillSpecies,
    createDriveReader,
  };
}

/**
 * `backfill-species [--list] [--dry-run] [--album <name>]... [--limit <n>]`: identifies species in photos that
 * are already indexed. The albums and photos come from the index (D1), local files and Google Drive alike.
 * `--list` shows how many photos per album still need a scan.
 */
export async function runBackfillSpecies(args: string[], deps?: BackfillSpeciesCliDeps): Promise<number> {
  const parsed = parseSpeciesArgs(args);
  if ('error' in parsed) {
    console.error(`Error: ${parsed.error}`);
    return 1;
  }
  try {
    const d = deps ?? (await defaultDeps());
    if (!d.sidecar) {
      console.error('Error: SPECIES_SIDECAR_URL is not set (start the species sidecar, see agent/sidecar/README.md)');
      return 1;
    }
    const model = await d.sidecar.model();

    if (parsed.list) {
      const albums = await d.cloudflareClient.speciesSummary(model);
      let pending = 0;
      for (const a of albums) {
        pending += a.pending;
        console.log(`${(a.album ?? '(no album)').padEnd(50)} ${a.pending} of ${a.total} to scan`);
      }
      console.log(`${pending} photo${pending === 1 ? '' : 's'} to scan with ${model}`);
      return 0;
    }

    const openDriveFile = await d.createDriveReader(d.config, {
      onNoLogin: () => console.log('No stored Google login: Google Drive photos will be skipped (run index-drive once to sign in).'),
    });
    if (!openDriveFile) console.log('Google Drive photos will be skipped (no usable Google login; run index-drive once to sign in).');

    const result = await d.backfill({
      cloudflareClient: d.cloudflareClient,
      sidecar: d.sidecar,
      regions: d.regions,
      openDriveFile,
      albums: parsed.albums,
      limit: parsed.limit,
      dryRun: parsed.dryRun,
      onProgress: (message) => console.log(message),
    });
    console.log(
      `Done${parsed.dryRun ? ' (dry run, nothing written)' : ''}. Pending: ${result.total}, Scanned: ${result.scanned}, With species: ${result.withSpecies}, File missing: ${result.missing}, Drive skipped: ${result.skippedDrive}, Not indexed: ${result.notIndexed}, Failed: ${result.failed}`
    );
    return result.failed > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** `build-species-regions [region]...`: builds the species list of each region (default: all in regions.json) from GBIF. */
export async function runBuildSpeciesRegions(
  args: string[],
  deps?: { regions: RegionsConfig; build: typeof buildRegionFile; dir: string }
): Promise<number> {
  try {
    const { regions, build, dir } = deps ?? { regions: await loadRegionsConfig(regionsFile()), build: buildRegionFile, dir: REGIONS_DIR };
    const names = args.length > 0 ? args : Object.keys(regions.regions);
    for (const name of names) {
      if (!(name in regions.regions)) {
        console.error(`Error: unknown region "${name}" (known: ${Object.keys(regions.regions).join(', ')})`);
        return 1;
      }
    }
    for (const name of names) {
      const file = await build(name, regions.regions[name], dir);
      console.log(`Built ${name}: ${file}`);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
