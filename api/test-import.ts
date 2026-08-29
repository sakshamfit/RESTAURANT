import type { IncomingMessage, ServerResponse } from 'http';
import { initialSettings } from '../src/server/seed';
export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', cafeName: initialSettings.cafeName }));
}
