// Test: does importing types crash?
import type { CafeSettings } from '../src/types';

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'types import works'
  });
}
