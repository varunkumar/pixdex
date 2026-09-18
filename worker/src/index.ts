import { Hono } from 'hono';
import { requireIngestToken } from './auth';
import { checkHashesRoute } from './routes/ingest-check-hashes';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.use('/ingest/*', requireIngestToken);
app.post('/ingest/check-hashes', checkHashesRoute);

export default app;
