import { Hono } from 'hono';
import { requireIngestToken } from './auth';
import { checkHashesRoute } from './routes/ingest-check-hashes';
import { ingestPhotoRoute } from './routes/ingest-photo';
import { getThumbnailRoute, putThumbnailRoute } from './routes/ingest-thumbnail';
import { getAlbumsRoute, getPhotoRoute } from './routes/photos';
import { searchRoute } from './routes/search';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.use('/ingest/*', requireIngestToken);
app.post('/ingest/check-hashes', checkHashesRoute);
app.post('/ingest/photo', ingestPhotoRoute);
app.put('/ingest/thumbnail/:contentHash', putThumbnailRoute);

app.get('/thumbnails/:contentHash', getThumbnailRoute);

app.get('/search', searchRoute);

app.get('/photos/:id', getPhotoRoute);
app.get('/albums', getAlbumsRoute);

export default app;
