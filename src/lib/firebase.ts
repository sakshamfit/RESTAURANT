import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  serverTimestamp,
  Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { Order, Product, CafeCategory, CafeTable, CafeSettings, WaiterCall, CustomerFeedback } from '../types';

// Initialize Firebase App
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// Use specific custom Firestore database ID
export const db: Firestore = getFirestore(
  app,
  firebaseConfig.firestoreDatabaseId || '(default)'
);

export {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  serverTimestamp,
};

// ==========================================
// REAL-TIME FIRESTORE SUBSCRIPTION HOOKS & HELPERS
// ==========================================

/**
 * Listen in real time to all live orders (for kitchen/admin dashboard)
 */
export function subscribeToOrders(
  callback: (orders: Order[]) => void,
  onError?: (err: Error) => void
) {
  try {
    const ordersCol = collection(db, 'orders');
    return onSnapshot(
      ordersCol,
      (snapshot) => {
        const orders: Order[] = [];
        snapshot.forEach((docSnap) => {
          orders.push({ id: docSnap.id, ...(docSnap.data() as any) });
        });
        // Sort descending by timeline.createdAt
        orders.sort(
          (a, b) =>
            new Date(b.timeline?.createdAt || 0).getTime() -
            new Date(a.timeline?.createdAt || 0).getTime()
        );
        callback(orders);
      },
      (err) => {
        console.warn('Firestore orders live listener fallback:', err);
        if (onError) onError(err);
      }
    );
  } catch (err: any) {
    console.warn('Firestore orders subscription failed to start:', err);
    if (onError) onError(err);
    return () => {};
  }
}

/**
 * Listen in real time to a single order's status (for customer tracking)
 */
export function subscribeToOrder(
  orderId: string,
  callback: (order: Order | null) => void,
  onError?: (err: Error) => void
) {
  try {
    const orderDocRef = doc(db, 'orders', orderId);
    return onSnapshot(
      orderDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          callback({ id: docSnap.id, ...(docSnap.data() as any) });
        } else {
          callback(null);
        }
      },
      (err) => {
        console.warn(`Firestore order ${orderId} live listener error:`, err);
        if (onError) onError(err);
      }
    );
  } catch (err: any) {
    console.warn(`Firestore subscription for order ${orderId} failed:`, err);
    if (onError) onError(err);
    return () => {};
  }
}

/**
 * Listen in real time to active waiter calls
 */
export function subscribeToWaiterCalls(
  callback: (calls: WaiterCall[]) => void,
  onError?: (err: Error) => void
) {
  try {
    const callsCol = collection(db, 'waiterCalls');
    return onSnapshot(
      callsCol,
      (snapshot) => {
        const calls: WaiterCall[] = [];
        snapshot.forEach((docSnap) => {
          calls.push({ id: docSnap.id, ...(docSnap.data() as any) });
        });
        calls.sort(
          (a, b) =>
            new Date(b.calledAt || b.createdAt || 0).getTime() -
            new Date(a.calledAt || a.createdAt || 0).getTime()
        );
        callback(calls);
      },
      (err) => {
        console.warn('Firestore waiterCalls live listener error:', err);
        if (onError) onError(err);
      }
    );
  } catch (err: any) {
    console.warn('Firestore waiter calls subscription error:', err);
    if (onError) onError(err);
    return () => {};
  }
}

/**
 * Listen in real time to customer feedback & ratings
 */
export function subscribeToFeedbacks(
  callback: (feedbacks: CustomerFeedback[]) => void,
  onError?: (err: Error) => void
) {
  try {
    const fbCol = collection(db, 'feedbacks');
    return onSnapshot(
      fbCol,
      (snapshot) => {
        const list: CustomerFeedback[] = [];
        snapshot.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...(docSnap.data() as any) });
        });
        list.sort(
          (a, b) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime()
        );
        callback(list);
      },
      (err) => {
        console.warn('Firestore feedbacks listener error:', err);
        if (onError) onError(err);
      }
    );
  } catch (err: any) {
    console.warn('Firestore feedbacks subscription error:', err);
    if (onError) onError(err);
    return () => {};
  }
}

/**
 * Listen in real time to cafe settings
 */
export function subscribeToSettings(
  callback: (settings: CafeSettings) => void,
  onError?: (err: Error) => void
) {
  try {
    const settingsDoc = doc(db, 'settings', 'config');
    return onSnapshot(
      settingsDoc,
      (docSnap) => {
        if (docSnap.exists()) {
          callback(docSnap.data() as CafeSettings);
        }
      },
      (err) => {
        console.warn('Firestore settings listener error:', err);
        if (onError) onError(err);
      }
    );
  } catch (err: any) {
    console.warn('Firestore settings subscription error:', err);
    if (onError) onError(err);
    return () => {};
  }
}

/**
 * Direct save helper to ensure realtime sync across all connected clients
 */
export async function syncOrderToFirestore(order: Order): Promise<void> {
  try {
    if (!order.id) return;
    const orderRef = doc(db, 'orders', order.id);
    await setDoc(orderRef, order, { merge: true });
  } catch (err) {
    console.error('Failed to sync order to Firestore:', err);
  }
}

export async function syncFeedbackToFirestore(feedback: CustomerFeedback): Promise<void> {
  try {
    if (!feedback.id) return;
    const fbRef = doc(db, 'feedbacks', feedback.id);
    await setDoc(fbRef, feedback, { merge: true });
  } catch (err) {
    console.error('Failed to sync feedback to Firestore:', err);
  }
}

export async function syncWaiterCallToFirestore(call: WaiterCall): Promise<void> {
  try {
    if (!call.id) return;
    const callRef = doc(db, 'waiterCalls', call.id);
    await setDoc(callRef, call, { merge: true });
  } catch (err) {
    console.error('Failed to sync waiter call to Firestore:', err);
  }
}
