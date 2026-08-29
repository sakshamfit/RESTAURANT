import type { IncomingMessage, ServerResponse } from 'http';
// Just try to import seed without using it
import '../src/server/seed';
export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', message: 'seed module loaded' }));
}
