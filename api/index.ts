// Vercel serverless entry point - minimal version to test routing
import type { IncomingMessage, ServerResponse } from 'http';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || 'GET';
  
  // Health check
  if (path === '/api/health' && method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      message: 'API is running',
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  // Admin login
  if (path === '/api/admin/login' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body);
        if (password === '9852120609@') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            message: 'Login successful',
            token: 'test-token-' + Date.now(),
            user: { email: email || 'admin@nagoritea.com' }
          }));
        } else {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, message: 'Invalid password' }));
        }
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
      }
    });
    return;
  }
  
  // 404 for unmatched routes
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found' }));
}
