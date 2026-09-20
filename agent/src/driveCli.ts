import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { getAuthorizedClient as defaultGetAuthorizedClient } from './google/auth';
import { listDriveFolders as defaultListDriveFolders, type DriveFilesClient } from './google/driveFiles';
import { indexGoogleDriveFolder as defaultIndexGoogleDriveFolder } from './google/indexGoogleDriveFolder';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import type { AgentConfig } from './config';

export interface RunIndexDriveDeps {
  prompt: (question: string) => Promise<string>;
  getAuthorizedClient?: typeof defaultGetAuthorizedClient;
  buildDriveClient?: (auth: OAuth2Client) => DriveFilesClient;
  listDriveFolders?: typeof defaultListDriveFolders;
  indexGoogleDriveFolder?: typeof defaultIndexGoogleDriveFolder;
}

export async function runIndexDrive(config: AgentConfig, deps: RunIndexDriveDeps): Promise<number> {
  const {
    prompt,
    getAuthorizedClient = defaultGetAuthorizedClient,
    buildDriveClient = (auth) => google.drive({ version: 'v3', auth }).files as unknown as DriveFilesClient,
    listDriveFolders = defaultListDriveFolders,
    indexGoogleDriveFolder = defaultIndexGoogleDriveFolder,
  } = deps;

  const auth = await getAuthorizedClient(config);
  const driveClient = buildDriveClient(auth as OAuth2Client);

  const searchTerm = (await prompt('Search Google Drive folders by name: ')).trim();
  const folders = await listDriveFolders(driveClient, searchTerm);

  if (folders.length === 0) {
    console.error(`No folders found matching "${searchTerm}"`);
    return 1;
  }

  console.log('Matching folders:');
  folders.forEach((folder, i) => console.log(`  ${i + 1}. ${folder.name}`));

  const choice = Number((await prompt(`Pick a folder (1-${folders.length}): `)).trim());
  const selected = folders[choice - 1];
  if (!selected) {
    console.error('Invalid selection');
    return 1;
  }

  const result = await indexGoogleDriveFolder(driveClient, selected.id, selected.name, {
    cloudflareClient: new CloudflareClient(config),
    ollamaClient: new OllamaClient(config),
    config,
    onProgress: (message) => console.log(message),
  });

  console.log(
    `Done. Total: ${result.total}, Indexed: ${result.indexed}, Skipped: ${result.skipped}, Failed: ${result.failed}`
  );
  return 0;
}
