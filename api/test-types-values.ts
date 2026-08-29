// Test: does importing from types with actual values (not just type imports) crash?
import type { CafeSettings, CafeTable } from '../src/types';

const testSettings: CafeSettings = {
  cafeName: 'Test',
  tagline: 'Test',
  address: 'Test',
  phone: '123',
  currency: '₹',
  upiId: 'test@upi',
  enableWhatsAppAlerts: false,
  whatsappApiUrl: '',
  whatsappApiToken: '',
  enableSoundAlerts: false,
};

export default function handler(req: any, res: any) {
  res.status(200).json({ 
    status: 'ok', 
    message: 'types with values work',
    cafeName: testSettings.cafeName
  });
}
