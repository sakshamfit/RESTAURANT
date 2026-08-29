// Test: does the seed module crash?
import { initialSettings, createMemorySnapshot } from '../src/server/seed';

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'seed module works',
    cafeName: initialSettings.cafeName
  });
}
