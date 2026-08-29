// Test: can we just import the store module without using it?
import '../src/server/store';

export default function handler(req: any, res: any) {
  res.status(200).json({ status: 'ok', message: 'Store module imported successfully' });
}
