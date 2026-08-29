import React, { useEffect, useState, useRef } from 'react';
import { Clock, ChefHat, CheckCircle2, AlertCircle, ArrowLeft, RefreshCw, Sparkles, Receipt, Bell } from 'lucide-react';
import { Order, OrderStatus, CafeSettings } from '../types';
import { api } from '../services/api';
import { subscribeToOrder } from '../lib/firebase';
import { playOrderAcceptedSound, playOrderReadySound, playCustomerOrderSuccessSound, sendBrowserNotification, unlockAudio } from '../utils/audioAlerts';
import { CustomerFeedbackCard } from './CustomerFeedbackCard';

interface OrderStatusTrackerProps {
  orderId: string;
  settings: CafeSettings;
  onBackToMenu: () => void;
}

export const OrderStatusTracker: React.FC<OrderStatusTrackerProps> = ({
  orderId,
  settings,
  onBackToMenu,
}) => {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [callingWaiter, setCallingWaiter] = useState<boolean>(false);
  const [waiterCalledSuccess, setWaiterCalledSuccess] = useState<boolean>(false);

  const prevStatusRef = useRef<OrderStatus | null>(null);

  const fetchOrder = async (isManual = false) => {
    try {
      if (isManual) setLoading(true);
      const data = await api.trackOrder(orderId);
      setOrder(data.order);
      setError(null);
      setLastRefreshed(new Date());
    } catch (err: any) {
      if (!order) {
        setError(err?.message || 'Unable to refresh order status.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrder();

    // Realtime listener from Firestore
    const unsubscribeFirestore = subscribeToOrder(orderId, (liveOrder) => {
      if (liveOrder) {
        setOrder(liveOrder);
        setLoading(false);
        setError(null);
        setLastRefreshed(new Date());
      }
    });

    // Fallback sync interval
    const timer = setInterval(() => {
      fetchOrder(false);
    }, 4000);

    return () => {
      clearInterval(timer);
      if (typeof unsubscribeFirestore === 'function') {
        unsubscribeFirestore();
      }
    };
  }, [orderId]);

  // Watch for status changes to trigger instant customer notifications
  useEffect(() => {
    if (order) {
      if (prevStatusRef.current && prevStatusRef.current !== order.status) {
        unlockAudio();
        if (order.status === 'accepted') {
          playOrderAcceptedSound();
          sendBrowserNotification(
            `${settings.cafeName} • Kitchen Alert`,
            `Chef has ACCEPTED your order #${order.orderNumber}! Food is being prepared.`
          );
          setStatusBanner('👨‍🍳 Chef Accepted Your Order: Now Cooking in Kitchen!');
        } else if (order.status === 'ready') {
          playOrderReadySound();
          sendBrowserNotification(
            `${settings.cafeName} • Food Ready!`,
            `Your order #${order.orderNumber} is READY and being served to ${order.tableName}!`
          );
          setStatusBanner('✨ Food is Ready! Being served to your table.');
        } else if (order.status === 'completed') {
          playCustomerOrderSuccessSound();
          sendBrowserNotification(
            `${settings.cafeName} • Order Completed`,
            `Your order #${order.orderNumber} is completed. Enjoy your meal!`
          );
          setStatusBanner('✅ Order Completed! Thank you for dining with us.');
        }
      }
      prevStatusRef.current = order.status;
    }
  }, [order?.status]);

  const handleCallWaiter = async () => {
    if (!order) return;
    try {
      setCallingWaiter(true);
      await api.callWaiter({
        tableNumber: order.tableNumber,
        tableName: order.tableName,
        customerName: order.customerName,
      });
      setWaiterCalledSuccess(true);
      setTimeout(() => setWaiterCalledSuccess(false), 5000);
    } catch (err: any) {
      alert(err?.message || 'Failed to call waiter. Please ask staff directly.');
    } finally {
      setCallingWaiter(false);
    }
  };

  const getStepState = (currentStatus: OrderStatus, targetStep: OrderStatus): 'done' | 'active' | 'upcoming' => {
    const orderLevels: Record<OrderStatus, number> = {
      new: 1,
      accepted: 2,
      ready: 3,
      completed: 4,
      cancelled: 0,
    };

    const currentLevel = orderLevels[currentStatus] || 0;
    const targetLevel = orderLevels[targetStep] || 0;

    if (currentStatus === 'cancelled') return 'upcoming';
    if (currentLevel > targetLevel) return 'done';
    if (currentLevel === targetLevel) return 'active';
    return 'upcoming';
  };

  if (loading && !order) {
    return (
      <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-[#ea580c] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-[#78716c] text-xs font-semibold">Loading order status...</p>
        </div>
      </div>
    );
  }

  if (error && !order) {
    return (
      <div className="min-h-screen bg-[#faf8f5] p-4 flex items-center justify-center font-sans">
        <div className="max-w-md w-full bg-white rounded-lg p-6 text-center border border-[#e7e2dc] shadow-xs space-y-4">
          <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
          <h2 className="text-lg font-semibold text-[#292524]">Order Not Found</h2>
          <p className="text-xs text-[#78716c]">{error}</p>
          <button
            onClick={onBackToMenu}
            className="w-full py-2.5 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white rounded-md font-semibold text-xs cursor-pointer transition-colors"
          >
            Return to Menu
          </button>
        </div>
      </div>
    );
  }

  if (!order) return null;

  return (
    <div className="min-h-screen bg-[#faf8f5] text-[#292524] pb-20 font-sans">
      {/* Header */}
      <div className="bg-[#1e130c] text-white px-4 py-4 sticky top-0 z-10 border-b border-[#3d2618]">
        <div className="max-w-xl mx-auto flex items-center justify-between">
          <button
            onClick={onBackToMenu}
            className="flex items-center gap-1.5 text-xs font-semibold text-[#fed7aa] hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Menu</span>
          </button>

          <div className="text-center">
            <h2 className="text-sm font-semibold text-white tracking-tight">Order #{order.orderNumber}</h2>
            <p className="text-[11px] text-[#e2d9d2] font-normal">{order.tableName} • {order.customerName}</p>
          </div>

          <button
            onClick={() => fetchOrder(true)}
            className="p-1.5 text-[#fed7aa] hover:text-white rounded-md transition-colors cursor-pointer"
            title="Refresh Status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 mt-6 space-y-4">
        {/* Live Kitchen Notification Toast/Banner */}
        {statusBanner && (
          <div className="p-3 bg-[#1e130c] text-white border border-[#3d2618] rounded-md shadow-xs flex items-center justify-between text-xs font-semibold">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#ea580c] shrink-0" />
              <span>{statusBanner}</span>
            </div>
            <button
              onClick={() => setStatusBanner(null)}
              className="text-[10px] text-[#fed7aa] hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Quick Call Waiter Button at Table */}
        <div className="bg-white p-3.5 rounded-lg border border-[#e7e2dc] flex items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-[#faf8f5] border border-[#e7e2dc] text-[#ea580c] flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <p className="text-xs font-semibold text-[#292524] leading-tight">Need assistance at table?</p>
              <p className="text-[11px] text-[#78716c]">Notify waiter for {order.tableName}</p>
            </div>
          </div>

          <button
            onClick={handleCallWaiter}
            disabled={callingWaiter || waiterCalledSuccess}
            className={`py-2 px-3.5 rounded-full font-semibold text-xs transition-all shrink-0 flex items-center gap-1.5 cursor-pointer ${
              waiterCalledSuccess
                ? 'bg-emerald-600 text-white'
                : 'bg-[#fed7aa] hover:bg-[#fdba74] text-[#1e130c]'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>{callingWaiter ? 'Calling...' : waiterCalledSuccess ? 'Waiter Notified' : 'Call Waiter'}</span>
          </button>
        </div>

        {/* Status Highlight Card */}
        <div className="bg-white rounded-lg p-6 border border-[#e7e2dc] shadow-xs text-center">
          {order.status === 'new' && (
            <div className="space-y-2">
              <div className="w-12 h-12 rounded-full bg-[#faf8f5] border border-[#e7e2dc] text-[#ea580c] flex items-center justify-center mx-auto">
                <Clock className="w-6 h-6 animate-pulse" />
              </div>
              <h3 className="text-base font-semibold text-[#292524]">Order Placed</h3>
              <p className="text-xs text-[#78716c] max-w-xs mx-auto">
                Waiting for the café chef to accept your order.
              </p>
            </div>
          )}

          {order.status === 'accepted' && (
            <div className="space-y-2">
              <div className="w-12 h-12 rounded-full bg-[#faf8f5] border border-[#e7e2dc] text-[#ea580c] flex items-center justify-center mx-auto">
                <ChefHat className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-[#292524]">Preparing in Kitchen</h3>
              <p className="text-xs text-[#78716c] max-w-xs mx-auto">
                Your food is being freshly prepared with care.
              </p>
            </div>
          )}

          {order.status === 'ready' && (
            <div className="space-y-2">
              <div className="w-12 h-12 rounded-full bg-[#1e130c] text-[#ea580c] flex items-center justify-center mx-auto shadow-xs animate-pulse">
                <Sparkles className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-emerald-800">Food is Ready!</h3>
              <p className="text-xs text-[#78716c] max-w-xs mx-auto">
                Your order is ready and on its way to <strong>{order.tableName}</strong>.
              </p>
            </div>
          )}

          {order.status === 'completed' && (
            <div className="space-y-2">
              <div className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-emerald-800">Order Completed</h3>
              <p className="text-xs text-[#78716c] max-w-xs mx-auto">
                Thank you for visiting {settings.cafeName}! We hope you enjoy your meal.
              </p>
            </div>
          )}

          {order.status === 'cancelled' && (
            <div className="space-y-2">
              <div className="w-12 h-12 rounded-full bg-red-50 border border-red-200 text-red-700 flex items-center justify-center mx-auto">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-red-700">Order Cancelled</h3>
              <p className="text-xs text-[#78716c] max-w-xs mx-auto">
                {order.cancellationReason || 'This order was cancelled by the café staff.'}
              </p>
            </div>
          )}

          {/* Stepper Timeline */}
          {order.status !== 'cancelled' && (
            <div className="grid grid-cols-4 gap-1 mt-6 pt-5 border-t border-[#e7e2dc]">
              {[
                { key: 'new', label: 'Received' },
                { key: 'accepted', label: 'Cooking' },
                { key: 'ready', label: 'Ready' },
                { key: 'completed', label: 'Served' },
              ].map((step, idx) => {
                const state = getStepState(order.status, step.key as OrderStatus);
                return (
                  <div key={step.key} className="flex flex-col items-center">
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                        state === 'done'
                          ? 'bg-emerald-600 text-white'
                          : state === 'active'
                          ? 'bg-[#ea580c] text-white ring-3 ring-[#fed7aa]'
                          : 'bg-[#e7e2dc] text-[#78716c]'
                      }`}
                    >
                      {idx + 1}
                    </div>
                    <span
                      className={`text-[10px] font-semibold mt-1.5 ${
                        state === 'active' || state === 'done' ? 'text-[#1e130c]' : 'text-[#78716c]'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Itemized Bill Card */}
        <div className="bg-white rounded-lg p-5 border border-[#e7e2dc] shadow-xs space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#e7e2dc]">
            <h4 className="font-semibold text-xs text-[#292524] flex items-center gap-1.5">
              <Receipt className="w-3.5 h-3.5 text-[#ea580c]" />
              <span>Bill Details</span>
            </h4>
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                order.paymentStatus === 'paid'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-amber-50 text-amber-800 border border-amber-200'
              }`}
            >
              {order.paymentStatus.toUpperCase()}
            </span>
          </div>

          <div className="space-y-1.5">
            {order.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-xs py-1 border-b border-[#faf8f5]">
                <div className="text-[#292524]">
                  <span className="font-bold text-[#1e130c] mr-2">{item.quantity}×</span>
                  <span className="font-medium">{item.productName}</span>
                  {item.variantName && (
                    <span className="text-[#78716c] ml-1">({item.variantName})</span>
                  )}
                </div>
                <span className="font-semibold text-[#1e130c]">
                  {settings.currency}{item.totalPrice}
                </span>
              </div>
            ))}
          </div>

          {order.specialInstructions && (
            <div className="p-2.5 bg-[#faf8f5] rounded-md text-xs text-[#78716c] border border-[#e7e2dc]">
              <strong>Note:</strong> {order.specialInstructions}
            </div>
          )}

          <div className="pt-2 border-t border-[#e7e2dc] flex justify-between items-center">
            <span className="text-xs font-semibold text-[#78716c]">Total Amount</span>
            <span className="text-lg font-bold text-[#1e130c]">
              {settings.currency}{order.totalAmount}
            </span>
          </div>
        </div>

        {/* Customer Rating & Feedback Section */}
        <CustomerFeedbackCard order={order} settings={settings} />

        {/* Back to Menu Action */}
        <button
          onClick={onBackToMenu}
          className="w-full py-3 bg-white hover:bg-[#faf8f5] text-[#1e130c] border border-[#e7e2dc] rounded-md font-semibold text-xs shadow-xs transition-colors cursor-pointer"
        >
          Add More Items / Return to Menu
        </button>
      </div>
    </div>
  );
};
