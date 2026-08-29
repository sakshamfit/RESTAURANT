// Test: can we load the store on Vercel?
import express from 'express';
import { store } from '../src/server/store';

const app = express();
app.get('/api/test-store', async (_req, res) => {
  try {
    await store.waitUntilReady();
    res.json({ status: 'ok', provider: store.provider, message: 'Store works' });
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

export default app;
