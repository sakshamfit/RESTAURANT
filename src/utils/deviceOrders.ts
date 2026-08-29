// Helper for storing and retrieving order IDs placed from the current mobile device/browser

const STORAGE_KEY = 'nagori_my_device_orders';

export function getMyDeviceOrderIds(): string[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to read device orders:', err);
    return [];
  }
}

export function saveMyDeviceOrderId(orderId: string): void {
  if (!orderId) return;
  try {
    const current = getMyDeviceOrderIds();
    if (!current.includes(orderId)) {
      const updated = [orderId, ...current];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    }
  } catch (err) {
    console.error('Failed to save device order ID:', err);
  }
}

export function isOrderFromThisDevice(orderId: string): boolean {
  const deviceOrders = getMyDeviceOrderIds();
  return deviceOrders.includes(orderId);
}

export function getSubmittedFeedbackForOrder(orderId: string): { rating: number; comment?: string } | null {
  try {
    const raw = localStorage.getItem(`nagori_feedback_${orderId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSubmittedFeedbackForOrder(orderId: string, rating: number, comment?: string): void {
  try {
    localStorage.setItem(
      `nagori_feedback_${orderId}`,
      JSON.stringify({ rating, comment, submittedAt: new Date().toISOString() })
    );
  } catch (err) {
    console.error('Failed to save submitted feedback locally:', err);
  }
}
