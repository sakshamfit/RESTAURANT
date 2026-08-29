// Test: minimal seed-like module
import type { IncomingMessage, ServerResponse } from 'http';

const createdAt = '2026-01-01T00:00:00.000Z';
const initialSettings = { cafeName: 'Test', tagline: 'Test' };
const initialTables = Array.from({ length: 2 }, (_, index) => ({
  id: `tbl-${index + 1}`, tableNumber: index + 1, createdAt,
}));

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', message: 'minimal seed works', tables: initialTables.length }));
}
