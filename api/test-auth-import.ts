// Test: does importing auth module crash?
import { getAdminEmail } from '../src/server/auth';

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'auth module works',
    email: getAdminEmail()
  });
}
