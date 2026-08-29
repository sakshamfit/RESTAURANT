// Test: does dotenv crash on Vercel?
import dotenv from 'dotenv';
dotenv.config();

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'dotenv works',
    vercel: process.env.VERCEL || 'not set'
  });
}
