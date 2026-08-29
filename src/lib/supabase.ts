import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CustomerFeedback, Order, WaiterCall } from '../types';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// The browser only receives Supabase's publishable/anon key. All writes go through
// the Express API. Admin login is the app's own single-admin flow (signed
// session tokens from /api/admin/login); supabase.auth is not used for it.
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;

const noop = () => {};

function authHeaders() {
  const token = localStorage.getItem('nagori_admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchAdmin<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(path, { headers: { ...authHeaders() } });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

function subscribeToTable(
  table: string,
  onEvent: () => void,
  onError?: (error: Error) => void,
  filter?: string,
) {
  if (!supabase) return noop;
  try {
    const channel = supabase
      .channel(`restaurant-${table}-${filter || 'all'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, onEvent)
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          onError?.(new Error(`Supabase Realtime ${status.toLowerCase()}.`));
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error('Supabase Realtime failed to start.'));
    return noop;
  }
}

/**
 * Hands a session token to the Supabase client for Realtime authorization.
 * Only real Supabase JWTs (three base64url segments) qualify; the app's own
 * admin session tokens are two-segment HMAC tokens and are deliberately
 * skipped (staff screens rely on the polling fallbacks in that case).
 */
export async function setSupabaseSession(accessToken: string, refreshToken?: string) {
  if (!supabase || !accessToken) return;
  const isSupabaseJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken);
  if (!isSupabaseJwt) return;
  if (refreshToken) {
    await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  } else {
    supabase.realtime.setAuth(accessToken);
  }
}

export function clearSupabaseSession() {
  if (supabase) void supabase.auth.signOut();
}

/** Supabase Realtime subscription for protected staff order updates. */
export function subscribeToOrders(callback: (orders: Order[]) => void, onError?: (error: Error) => void) {
  return subscribeToTable('app_orders', async () => {
    const result = await fetchAdmin<{ orders: Order[] }>('/api/admin/orders', { orders: [] });
    callback(result.orders);
  }, onError);
}

/** Supabase Realtime subscription for protected staff waiter-call updates. */
export function subscribeToWaiterCalls(callback: (calls: WaiterCall[]) => void, onError?: (error: Error) => void) {
  return subscribeToTable('app_waiter_calls', async () => {
    const result = await fetchAdmin<{ calls: WaiterCall[] }>('/api/admin/waiter-calls', { calls: [] });
    callback(result.calls);
  }, onError);
}

export function subscribeToFeedbacks(callback: (feedbacks: CustomerFeedback[]) => void, onError?: (error: Error) => void) {
  return subscribeToTable('app_feedbacks', async () => {
    const result = await fetchAdmin<{ feedbacks: CustomerFeedback[] }>('/api/admin/feedbacks', { feedbacks: [] });
    callback(result.feedbacks);
  }, onError);
}

/** Customer status updates use the public API after a Realtime event, with polling as a fallback. */
export function subscribeToOrder(orderId: string, callback: (order: Order | null) => void, onError?: (error: Error) => void) {
  return subscribeToTable('app_orders', async () => {
    const result = await fetch(`/api/orders/track/${encodeURIComponent(orderId)}`);
    if (result.ok) callback((await result.json()).order as Order);
  }, onError, `id=eq.${orderId}`);
}
