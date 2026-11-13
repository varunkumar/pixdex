import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  clearStoredToken as defaultClearStoredToken,
  getAuthorizedClient as defaultGetAuthorizedClient,
  isInvalidGrant,
} from './google/auth';
import {
  getDriveFolder as defaultGetDriveFolder,
  listDriveFolders as defaultListDriveFolders,
  parseDriveFolderRef,
  type DriveFilesClient,
  type DriveFolderRef,
} from './google/driveFiles';
import { indexGoogleDriveFolder as defaultIndexGoogleDriveFolder } from './google/indexGoogleDriveFolder';
import { dryRunDriveFolder, formatDryRun } from './google/dryRunDriveFolder';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import { loadKnownGallery } from './known/loadKnownGallery';
import { createFaceSidecar } from './faces/sidecarClient';
import type { AgentConfig } from './config';

export interface RunIndexDriveDeps {
  prompt: (question: string) => Promise<string>;
  /** CLI arguments after `index-drive`: repeatable `--folder <id-or-url>` skips the prompts. */
  args?: string[];
  getDriveFolder?: typeof defaultGetDriveFolder;
  clearStoredToken?: () => Promise<void>;
  getAuthorizedClient?: typeof defaultGetAuthorizedClient;
  buildDriveClient?: (auth: OAuth2Client) => DriveFilesClient;
  listDriveFolders?: typeof defaultListDriveFolders;
  indexGoogleDriveFolder?: typeof defaultIndexGoogleDriveFolder;
  dryRunDriveFolder?: typeof dryRunDriveFolder;
}

export function parseFolderArgs(args: string[]): {
  folders: string[];
  dryRun: boolean;
  exclude: string[];
  error?: string;
} {
  const folders: string[] = [];
  const exclude: string[] = [];
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--exclude') {
      const glob = (args[i + 1] ?? '').trim();
      if (!glob) return { folders, dryRun, exclude, error: '--exclude needs a folder name or pattern (e.g. "video" or "*.lrdata")' };
      exclude.push(glob);
      i++;
    } else if (args[i] === '--folder') {
      const id = parseDriveFolderRef(args[i + 1] ?? '');
      if (!id) {
        return { folders, dryRun, exclude, error: `--folder needs a Drive folder id or URL (got "${args[i + 1] ?? ''}")` };
      }
      folders.push(id);
      i++;
    } else {
      return { folders, dryRun, exclude, error: `Unknown argument: ${args[i]}` };
    }
  }
  return { folders, dryRun, exclude };
}

export async function runIndexDrive(config: AgentConfig, deps: RunIndexDriveDeps): Promise<number> {
  try {
    return await run(config, deps);
  } catch (error) {
    if (!isInvalidGrant(error)) throw error;
    // The stored refresh token is dead; drop it so the next run starts a fresh consent flow.
    await (deps.clearStoredToken ?? defaultClearStoredToken)();
    console.error('Google rejected the stored login (revoked or expired). It was cleared: run index-drive again to sign in.');
    return 1;
  }
}

async function run(config: AgentConfig, deps: RunIndexDriveDeps): Promise<number> {
  const {
    prompt,
    args = [],
    getAuthorizedClient = defaultGetAuthorizedClient,
    buildDriveClient = (auth) => google.drive({ version: 'v3', auth }).files as unknown as DriveFilesClient,
    listDriveFolders = defaultListDriveFolders,
    getDriveFolder = defaultGetDriveFolder,
    indexGoogleDriveFolder = defaultIndexGoogleDriveFolder,
    dryRunDriveFolder: runDryRun = dryRunDriveFolder,
  } = deps;

  const parsed = parseFolderArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    return 1;
  }

  const auth = await getAuthorizedClient(config);
  const driveClient = buildDriveClient(auth as OAuth2Client);

  let selected: DriveFolderRef[];
  if (parsed.folders.length > 0) {
    selected = [];
    for (const id of parsed.folders) selected.push(await getDriveFolder(driveClient, id));
  } else {
    const searchTerm = (await prompt('Search Google Drive folders by name: ')).trim();
    const folders = await listDriveFolders(driveClient, searchTerm);

    if (folders.length === 0) {
      console.error(`No folders found matching "${searchTerm}"`);
      return 1;
    }

    console.log('Matching folders:');
    folders.forEach((folder, i) => console.log(`  ${i + 1}. ${folder.name}${folder.parentName ? `  (in ${folder.parentName})` : ''}  [${folder.id}]`)
    );

    const choice = Number((await prompt(`Pick a folder (1-${folders.length}): `)).trim());
    const picked = folders[choice - 1];
    if (!picked) {
      console.error('Invalid selection');
      return 1;
    }
    selected = [picked];
  }

  const cloudflareClient = new CloudflareClient(config);

  if (parsed.dryRun) {
    // Listing only: no downloads, no Ollama, no face sidecar, nothing written anywhere.
    for (const folder of selected) {
      console.log(`Dry run for "${folder.name}" (nothing will be downloaded or indexed)`);
      const result = await runDryRun(driveClient, folder.id, folder.name, {
        cloudflareClient,
        config,
        onWarning: (message) => console.warn(message),
        onProgress: (message) => console.log(message),
        exclude: parsed.exclude,
      });
      formatDryRun(result).forEach((line) => console.log(line));
    }
    return 0;
  }

  const ollamaClient = new OllamaClient(config);
  const faceSidecar = createFaceSidecar(config);
  const knownGallery = await loadKnownGallery();

  let failedAny = false;
  for (const folder of selected) {
    console.log(`${new Date().toISOString()} Indexing "${folder.name}"`);
    const result = await indexGoogleDriveFolder(driveClient, folder.id, folder.name, {
      cloudflareClient,
      ollamaClient,
      config,
      faceSidecar,
      knownGallery,
      onProgress: (message) => console.log(`${new Date().toISOString()} ${message}`),
      exclude: parsed.exclude,
    });
    if (result.failed > 0) failedAny = true;
    console.log(
      `${new Date().toISOString()} Done. Total: ${result.total}, Indexed: ${result.indexed}, Skipped: ${result.skipped}, Failed: ${result.failed}`
    );
  }
  return failedAny && parsed.folders.length > 0 ? 1 : 0;
}
