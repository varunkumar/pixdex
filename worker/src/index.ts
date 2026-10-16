import { Hono } from 'hono';
import { requireIngestToken, requireReadToken } from './auth';
import { checkHashesRoute } from './routes/ingest-check-hashes';
import { ingestExifRoute } from './routes/ingest-exif';
import { ingestRatingRoute } from './routes/ingest-rating';
import { ingestPhotoRoute } from './routes/ingest-photo';
import { getThumbnailRoute, putThumbnailRoute } from './routes/ingest-thumbnail';
import { getAlbumsRoute, getPhotoRoute, patchPhotoRoute, putAlbumCoverRoute } from './routes/photos';
import { searchRoute } from './routes/search';
import { dailyPickRoute } from './routes/daily-pick';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.get('/health', (c) => c.text('ok'));

app.use('/ingest/*', requireIngestToken);
app.post('/ingest/check-hashes', checkHashesRoute);
app.post('/ingest/photo', ingestPhotoRoute);
app.post('/ingest/exif', ingestExifRoute);
app.post('/ingest/rating', ingestRatingRoute);
app.put('/ingest/thumbnail/:contentHash', putThumbnailRoute);

app.use('/thumbnails/*', requireReadToken);
app.get('/thumbnails/:contentHash', getThumbnailRoute);

app.use('/search', requireReadToken);
app.get('/search', searchRoute);

app.use('/photos/*', requireReadToken);
app.get('/photos/:id', getPhotoRoute);
app.patch('/photos/:id', patchPhotoRoute);

app.use('/albums', requireReadToken);
app.get('/albums', getAlbumsRoute);

app.use('/albums/cover', requireReadToken);
app.put('/albums/cover', putAlbumCoverRoute);

app.use('/daily-pick', requireReadToken);
app.get('/daily-pick', dailyPickRoute);

export default app;
