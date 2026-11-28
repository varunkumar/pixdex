import { backfillPlaces } from './backfillPlaces';
import { CloudflareClient } from './cloudflareClient';
import { loadConfig } from './config';
import { defaultGazetteerFile, loadGazetteer } from './places/gazetteer';

export interface BackfillPlacesCliDeps {
  cloudflareClient: Pick<CloudflareClient, 'placesPending' | 'ingestPlaces'>;
  loadGazetteer: typeof loadGazetteer;
}

const downloadSteps = (file: string) => `The town list is missing: ${file}
Download it once (GeoNames, CC BY 4.0):
  mkdir -p "$(dirname "${file}")"
  curl -fL https://download.geonames.org/export/dump/cities500.zip -o "${file}.zip"
  unzip -o "${file}.zip" -d "$(dirname "${file}")"`;

/** `backfill-places [--dry-run]`: town names for indexed photos with a GPS position. */
export async function runBackfillPlaces(args: string[], deps?: BackfillPlacesCliDeps): Promise<number> {
  const unknown = args.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`Error: unknown argument ${unknown[0]} (usage: backfill-places [--dry-run])`);
    return 1;
  }
  try {
    const d = deps ?? { cloudflareClient: new CloudflareClient(loadConfig()), loadGazetteer };
    const gazetteer = await d.loadGazetteer();
    if (!gazetteer) {
      console.error(downloadSteps(defaultGazetteerFile()));
      return 1;
    }
    const dryRun = args.includes('--dry-run');
    const r = await backfillPlaces({
      cloudflareClient: d.cloudflareClient,
      gazetteer,
      dryRun,
      onProgress: (message) => console.log(message),
    });
    console.log(
      `${dryRun ? 'Dry run, nothing written' : 'Done'}. Total: ${r.total}, With a town: ${r.placed}, No town: ${r.none}, Not indexed: ${r.notIndexed}`
    );
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
