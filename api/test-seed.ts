// Test: does seed module crash with correct response API?
import type { IncomingMessage, ServerResponse } from 'http';
import { initialSettings, createMemorySnapshot } from '../src/server/seed';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', message: 'seed module works', cafeName: initialSettings.cafeName }));
}
