// Test: which dependency crashes?
import net from 'net';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { readFile } from 'fs/promises';

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'Node.js built-ins and fs/promises work' 
  });
}
