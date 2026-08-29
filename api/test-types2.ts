import type { IncomingMessage, ServerResponse } from 'http';
import type { CafeSettings } from '../src/types';
export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', message: 'types import works' }));
}
