import { Hono } from 'hono';
import { requireIngestToken } from './auth';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.use('/ingest/*', requireIngestToken);
app.post('/ingest/check-hashes', (c) => c.json({ known: [] })); // placeholder, replaced in Task 4

export default app;
