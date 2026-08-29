// Test: minimal seed-like module
const createdAt = '2026-01-01T00:00:00.000Z';

const initialSettings = {
  cafeName: 'Test',
  tagline: 'Test',
};

const initialTables = Array.from({ length: 2 }, (_, index) => ({
  id: `tbl-${index + 1}`,
  tableNumber: index + 1,
  createdAt,
}));

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'minimal seed works',
    tables: initialTables.length
  });
}
