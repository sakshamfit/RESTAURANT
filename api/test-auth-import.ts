// Test: does importing auth module crash?
import type { IncomingMessage, ServerResponse } from 'http';
import { getAdminEmail } from '../src/server/auth';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', message: 'auth module works', email: getAdminEmail() }));
}
