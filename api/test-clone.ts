// Test: does structuredClone work on Vercel?
export default function handler(req: any, res: any) {
  try {
    const obj = { a: 1, b: { c: 2 } };
    const cloned = structuredClone(obj);
    res.status(200).json({ 
      status: 'ok', 
      message: 'structuredClone works',
      cloned
    });
  } catch (error: any) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message
    });
  }
}
