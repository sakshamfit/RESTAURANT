import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShoppingBag,
  X,
  RefreshCw,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChefHat,
  UtensilsCrossed,
  ArrowRight,
  Radio,
  Smartphone,
  Star,
  CalendarDays,
  WifiOff,
} from 'lucide-react';
import { CafeTable, CafeSettings, Order } from '../types';
import { api } from '../services/api';
import { getMyDeviceOrderIds, getSubmittedFeedbackForOrder } from '../utils/deviceOrders';
import { formatOrderDateTime } from '../utils/datetime';

interface TableOrderHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  table: CafeTable;
  settings: CafeSettings;
  onSelectOrderToTrack: (orderId: string) => void;
}

export const TableOrderHistoryModal: React.FC<TableOrderHistoryModalProps> = ({
  isOpen,
  onClose,
  table,
  settings,
  onSelectOrderToTrack,
}) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // A background refresh failed but the last good list is still on screen —
  // flagged with a subtle strip instead of blanking the modal with an error.
  const [refreshFailed, setRefreshFailed] = useState<boolean>(false);

  // Mirror of `orders` so the polling loop never reads stale state.
  const ordersRef = useRef<Order[]>([]);
  const applyOrders = useCallback((next: Order[]) => {
    ordersRef.current = next;
    setOrders(next);
  }, []);

  const fetchHistory = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;

      // This phone has never placed an order: skip the network entirely and
      // show the friendly empty state instantly (zero loading spinner).
      const deviceOrderIds = getMyDeviceOrderIds();
      if (deviceOrderIds.length === 0) {
        applyOrders([]);
        setError(null);
        setRefreshFailed(false);
        setLoading(false);
        return;
      }

      if (!silent && ordersRef.current.length === 0) setLoading(true);
      try {
        let myOrders: Order[] = [];
        try {
          // Primary source: look the phone's own orders up by ID — works for
          // every table the customer ever ordered from.
          const res = await api.getMyOrdersByIds(deviceOrderIds);
          myOrders = res.orders || [];
        } catch {
          // Fallback for an older backend without the lookup endpoint (or a
          // hiccup on it): pull the current table's orders and keep only the
          // ones placed from this device — the original behaviour.
          const res = await api.getTableOrders(table.token);
          myOrders = (res.orders || []).filter((o) => deviceOrderIds.includes(o.id));
        }
        applyOrders(myOrders);
        setError(null);
        setRefreshFailed(false);
      } catch (err: any) {
        if (ordersRef.current.length === 0) {
          setError(err?.message || 'Failed to load your orders.');
        } else {
          // Keep showing the last good list; statuses just stop auto-updating.
          setRefreshFailed(true);
        }
      } finally {
        setLoading(false);
      }
    },
    // `table` is only used by the fallback path, which needs its token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table?.token, applyOrders]
  );

  useEffect(() => {
    if (!isOpen || !table) return;
    fetchHistory();
    // Keep statuses live while the customer has the list open, without any
    // manual refresh. Polling stops the moment the modal closes.
    const interval = window.setInterval(() => {
      fetchHistory({ silent: true });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [isOpen, table?.token, fetchHistory]);

  if (!isOpen) return null;

  const totalTableSpending = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + o.totalAmount, 0);

  const getStatusBadge = (status: Order['status']) => {
    switch (status) {
      case 'new':
        return (
          <span className="px-2 py-0.5 bg-[#faf8f5] border border-[#e7e2dc] text-[#1e130c] rounded-full text-[10px] font-semibold inline-flex items-center gap-1">
            <Clock className="w-3 h-3 text-[#78716c]" /> Received
          </span>
        );
      case 'accepted':
        return (
          <span className="px-2 py-0.5 bg-[#2c190e] text-[#fed7aa] border border-[#452c1e] rounded-full text-[10px] font-semibold inline-flex items-center gap-1">
            <ChefHat className="w-3 h-3" /> Cooking
          </span>
        );
      case 'ready':
        return (
          <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-[10px] font-semibold inline-flex items-center gap-1">
            <UtensilsCrossed className="w-3 h-3" /> Ready
          </span>
        );
      case 'completed':
        return (
          <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-[10px] font-semibold inline-flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Completed
          </span>
        );
      case 'cancelled':
        return (
          <span className="px-2 py-0.5 bg-red-50 text-red-700 border border-red-200 rounded-full text-[10px] font-semibold inline-flex items-center gap-1">
            <AlertCircle className="w-3 h-3 text-red-500" /> Cancelled
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#140c07]/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 font-sans">
      <div className="bg-white w-full max-w-lg rounded-lg shadow-2xl border border-[#e7e2dc] flex flex-col max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-[#3d2618] flex items-center justify-between bg-[#1e130c] text-white">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-[#2c190e] text-[#ea580c] border border-[#452c1e] flex items-center justify-center font-bold">
              <ShoppingBag className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-white leading-tight flex items-center gap-2">
                <span>My Orders</span>
                <span className="bg-[#2c190e] text-[#fed7aa] border border-[#452c1e] text-[10px] px-2 py-0.2 rounded-full font-mono flex items-center gap-1">
                  <Smartphone className="w-2.5 h-2.5" />
                  This Phone
                </span>
              </h3>
              <p className="text-[11px] text-[#e2d9d2]">
                Every order placed from this device, with its date
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fetchHistory()}
              disabled={loading}
              className="p-1.5 text-[#fed7aa] hover:text-white rounded-md transition-colors cursor-pointer disabled:opacity-60"
              title="Refresh orders"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-[#fed7aa] hover:text-white rounded-md transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Running Bill Summary */}
        <div className="bg-[#faf8f5] border-b border-[#e7e2dc] px-4 py-2.5 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-[#78716c] font-medium">
            <Smartphone className="w-3.5 h-3.5 text-[#ea580c]" />
            <span>Orders on this phone: <strong className="text-[#292524]">{orders.length}</strong></span>
          </div>
          <div className="font-semibold text-[#78716c]">
            Total: <span className="text-[#1e130c] text-sm font-bold ml-1">{settings.currency}{totalTableSpending}</span>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#faf8f5]">
          {loading && orders.length === 0 && (
            <div className="py-12 text-center space-y-2">
              <div className="w-7 h-7 border-2 border-[#ea580c] border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs text-[#78716c]">Fetching your orders...</p>
            </div>
          )}

          {error && orders.length === 0 && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
              <span>{error}</span>
              <button
                onClick={() => fetchHistory()}
                className="ml-auto py-1 px-2.5 bg-red-600 hover:bg-red-700 text-white rounded font-semibold text-[11px] cursor-pointer transition-colors shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {refreshFailed && orders.length > 0 && (
            <div className="p-2 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-[11px] flex items-center gap-2">
              <WifiOff className="w-3.5 h-3.5 shrink-0" />
              <span>Couldn't refresh just now — showing your latest saved orders. Pull the refresh button to retry.</span>
            </div>
          )}

          {!loading && orders.length === 0 && !error && (
            <div className="py-12 text-center space-y-2 px-4">
              <div className="w-10 h-10 bg-white border border-[#e7e2dc] text-[#78716c] rounded-full flex items-center justify-center mx-auto">
                <Smartphone className="w-5 h-5" />
              </div>
              <h4 className="font-semibold text-xs text-[#292524]">No Orders Yet</h4>
              <p className="text-xs text-[#78716c] max-w-xs mx-auto">
                Orders placed from this phone will appear here with their date so you can track them in real time.
              </p>
              <button
                onClick={onClose}
                className="mt-2 py-2 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white rounded-md text-xs font-semibold cursor-pointer transition-colors"
              >
                Order from Menu
              </button>
            </div>
          )}

          {orders.map((order) => (
            <div
              key={order.id}
              onClick={() => {
                onSelectOrderToTrack(order.id);
                onClose();
              }}
              className="bg-white border border-[#e7e2dc] hover:border-[#ea580c] rounded-md p-3.5 shadow-xs space-y-2.5 transition-all cursor-pointer group"
            >
              {/* Top Row: Order ID, Table, Date & Status */}
              <div className="flex items-center justify-between gap-2 border-b border-[#faf8f5] pb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono font-bold text-xs text-[#1e130c]">
                      {order.orderNumber}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#faf8f5] border border-[#e7e2dc] text-[#78716c] font-semibold whitespace-nowrap">
                      {order.tableName}
                    </span>
                    <span className="text-[10px] text-[#78716c] font-medium inline-flex items-center gap-1 whitespace-nowrap">
                      <CalendarDays className="w-3 h-3 text-[#ea580c]" />
                      {formatOrderDateTime(order.timeline.createdAt)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#78716c] mt-0.5">
                    Customer: <strong className="text-[#292524]">{order.customerName}</strong>
                  </p>
                </div>

                <div className="shrink-0">{getStatusBadge(order.status)}</div>
              </div>

              {/* Items List */}
              <div className="space-y-1 bg-[#faf8f5] rounded-md p-2 text-xs text-[#292524]">
                {order.items.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center text-[11px]">
                    <span className="font-medium text-[#292524]">
                      {item.quantity} × {item.productName}
                      {item.variantName ? ` (${item.variantName})` : ''}
                    </span>
                    <span className="font-semibold text-[#1e130c]">
                      {settings.currency}{item.totalPrice}
                    </span>
                  </div>
                ))}
              </div>

              {/* Bottom Row: Total Amount & Track Action */}
              <div className="flex items-center justify-between pt-1">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[#78716c] uppercase font-semibold block">Total</span>
                    {(() => {
                      const fb = getSubmittedFeedbackForOrder(order.id);
                      if (fb) {
                        return (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-[#faf8f5] border border-[#e7e2dc] text-[10px] font-semibold text-[#ea580c]">
                            <Star className="w-2.5 h-2.5 fill-[#ea580c] text-[#ea580c]" />
                            {fb.rating}★ Rated
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <span className="text-sm font-bold text-[#1e130c]">
                    {settings.currency}{order.totalAmount}
                  </span>
                  <span className={`text-[10px] ml-2 px-1.5 py-0.2 rounded font-semibold uppercase ${
                    order.paymentStatus === 'paid'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-amber-50 text-amber-800 border border-amber-200'
                  }`}>
                    {order.paymentStatus}
                  </span>
                </div>

                <div className="py-1.5 px-3 bg-[#ea580c] group-hover:bg-[#c2410c] text-white rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs">
                  <Radio className="w-3 h-3 text-[#fed7aa] animate-pulse" />
                  <span>Track Status</span>
                  <ArrowRight className="w-3 h-3" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[#e7e2dc] bg-white text-center">
          <button
            onClick={onClose}
            className="w-full py-2 bg-white hover:bg-[#faf8f5] text-[#292524] border border-[#e7e2dc] rounded-md text-xs font-semibold transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
