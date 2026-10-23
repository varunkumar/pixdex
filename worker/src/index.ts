import { Hono } from 'hono';
import { requireIngestToken, requireReadToken } from './auth';
import { checkHashesRoute } from './routes/ingest-check-hashes';
import { ingestFacesRoute, pendingFacesRoute, putFaceCropRoute, unscannedFacesRoute } from './routes/ingest-faces';
import { ingestExifRoute } from './routes/ingest-exif';
import { ingestRatingRoute } from './routes/ingest-rating';
import { ingestPhotoRoute } from './routes/ingest-photo';
import { ingestRelocateRoute } from './routes/ingest-relocate';
import { getThumbnailRoute, putThumbnailRoute } from './routes/ingest-thumbnail';
import { getAlbumsRoute, getPhotoRoute, patchPhotoRoute, putAlbumCoverRoute } from './routes/photos';
import { assignFaceRoute, faceCropRoute, photoFacesRoute, rejectFaceRoute, unassignFaceRoute } from './routes/faces';
import {
  assignFacesRoute,
  createPersonRoute,
  deletePersonRoute,
  groupsRoute,
  listPeopleRoute,
  matchPersonRoute,
  setPersonCoverRoute,
  renamePersonRoute,
} from './routes/people';
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
app.post('/ingest/relocate', ingestRelocateRoute);
app.post('/ingest/faces/pending', pendingFacesRoute);
app.post('/ingest/faces/unscanned', unscannedFacesRoute);
app.post('/ingest/faces', ingestFacesRoute);
app.put('/ingest/faces/:faceId/crop', putFaceCropRoute);
app.post('/ingest/rating', ingestRatingRoute);
app.put('/ingest/thumbnail/:contentHash', putThumbnailRoute);

app.use('/thumbnails/*', requireReadToken);
app.get('/thumbnails/:contentHash', getThumbnailRoute);

app.use('/search', requireReadToken);
app.get('/search', searchRoute);

app.use('/photos/*', requireReadToken);
app.get('/photos/:id', getPhotoRoute);
app.get('/photos/:id/faces', photoFacesRoute);
app.patch('/photos/:id', patchPhotoRoute);

app.use('/people', requireReadToken);
app.use('/people/*', requireReadToken);
app.get('/people', listPeopleRoute);
app.post('/people', createPersonRoute);
app.get('/people/groups', groupsRoute);
app.patch('/people/:id', renamePersonRoute);
app.delete('/people/:id', deletePersonRoute);
app.post('/people/:id/faces', assignFacesRoute);
app.post('/people/:id/match', matchPersonRoute);
app.post('/people/:id/cover', setPersonCoverRoute);

app.use('/faces/*', requireReadToken);
app.get('/faces/:id/crop', faceCropRoute);
app.post('/faces/:id/assign', assignFaceRoute);
app.post('/faces/:id/reject', rejectFaceRoute);
app.post('/faces/:id/unassign', unassignFaceRoute);

app.use('/albums', requireReadToken);
app.get('/albums', getAlbumsRoute);

app.use('/albums/cover', requireReadToken);
app.put('/albums/cover', putAlbumCoverRoute);

app.use('/daily-pick', requireReadToken);
app.get('/daily-pick', dailyPickRoute);

export default app;
