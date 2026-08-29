// Test: exact copy of test.ts structure
import type { IncomingMessage, ServerResponse } from 'http';

const message = 'Test with constants works';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', message }));
}
