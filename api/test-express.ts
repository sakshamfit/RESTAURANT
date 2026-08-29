// Test: can we load Express on Vercel?
import express from 'express';
import type { IncomingMessage, ServerResponse } from 'http';

const app = express();
app.get('/api/test-express', (_req, res) => {
  res.json({ status: 'ok', message: 'Express works' });
});

export default app;
