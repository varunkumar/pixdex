import { Hono, type Context } from 'hono';
import { requireIngestToken, requireReadToken } from './auth';
import { guardedWrites, requireDefaultOwner } from './access';
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
import { bucketsRoute, timelineRoute } from './routes/timeline';
import { dailyPickRoute } from './routes/daily-pick';
import { accessPhotoRoute, meRoute, putAlbumSharesRoute } from './routes/shares';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

type Handler = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

/** A write only the default owner may make (people management): requireDefaultOwner runs first. */
function ownerWrite(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, handler: Handler) {
  guardedWrites.add(`${method} ${path}`);
  app.on(method, path, requireDefaultOwner, handler);
}

/** A write whose handler authorizes with albumRole (404 no access, 403 viewer). */
function albumWrite(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, handler: Handler) {
  guardedWrites.add(`${method} ${path}`);
  app.on(method, path, handler);
}

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

app.use('/timeline', requireReadToken);
app.use('/timeline/*', requireReadToken);
app.get('/timeline', timelineRoute);
app.get('/timeline/buckets', bucketsRoute);

app.use('/photos/*', requireReadToken);
app.get('/photos/:id', getPhotoRoute);
app.get('/photos/:id/faces', photoFacesRoute);
albumWrite('PATCH', '/photos/:id', patchPhotoRoute);

app.use('/people', requireReadToken);
app.use('/people/*', requireReadToken);
app.get('/people', listPeopleRoute);
ownerWrite('POST', '/people', createPersonRoute);
app.get('/people/groups', groupsRoute);
ownerWrite('PATCH', '/people/:id', renamePersonRoute);
ownerWrite('DELETE', '/people/:id', deletePersonRoute);
ownerWrite('POST', '/people/:id/faces', assignFacesRoute);
ownerWrite('POST', '/people/:id/match', matchPersonRoute);
ownerWrite('POST', '/people/:id/cover', setPersonCoverRoute);

app.use('/faces/*', requireReadToken);
app.get('/faces/:id/crop', faceCropRoute);
ownerWrite('POST', '/faces/:id/assign', assignFaceRoute);
ownerWrite('POST', '/faces/:id/reject', rejectFaceRoute);
ownerWrite('POST', '/faces/:id/unassign', unassignFaceRoute);

app.use('/albums', requireReadToken);
app.get('/albums', getAlbumsRoute);

app.use('/albums/cover', requireReadToken);
albumWrite('PUT', '/albums/cover', putAlbumCoverRoute);

app.use('/albums/shares', requireReadToken);
albumWrite('PUT', '/albums/shares', putAlbumSharesRoute);

app.use('/access/*', requireReadToken);
app.get('/access/photo/:id', accessPhotoRoute);

app.use('/me', requireReadToken);
app.get('/me', meRoute);

app.use('/daily-pick', requireReadToken);
app.get('/daily-pick', dailyPickRoute);

export default app;
