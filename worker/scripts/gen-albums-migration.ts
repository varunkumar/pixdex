// Regenerates migrations/0015_albums.sql from migrations/albums.ts. Run via `npm run gen:albums-migration`.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { albumsMigrationSql } from '../migrations/albums';

writeFileSync(resolve(process.cwd(), 'migrations/0015_albums.sql'), albumsMigrationSql());
