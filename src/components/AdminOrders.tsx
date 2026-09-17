import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Clock,
  ChefHat,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Printer,
  DollarSign,
  User,
  MapPin,
  RefreshCw,
  Share2,
  Check,
  X,
  Volume2,
  VolumeX,
  Calendar,
  Sparkles,
} from 'lucide-react';
import { Order, OrderStatus, PaymentStatus, CafeSettings } from '../types';
import { api, generateWhatsAppOrderUrl } from '../services/api';
import { useToday } from '../utils/useToday';
import { formatOrderStamp, formatOrderTime, isSameLocalDay } from '../utils/datetime';

interface AdminOrdersProps {
  orders: Order[];
  settings: CafeSettings;
  onRefreshOrders: () => void;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
}

/** One bill sent to the printer. `seq` makes a repeated click on the same bill
 *  re-open the print sheet instead of being swallowed as a duplicate render. */
interface BillPrintJob {
  seq: number;
  order: Order;
}

/* Receipt amounts print exactly as stored (no forced decimals); a missing
 * value prints an ASCII dash instead of "undefined"/"NaN", because plain ASCII
 * is what every thermal driver and normal printer can render. */
const DASH = '-';
const receiptAmount = (value?: number) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : DASH;

/**
 * The printed bill. This node (`#printable-bill`) is the only thing
 * `@media print` leaves on the page (see src/index.css), and its layout is the
 * one the KOT popup used before: 280px-wide monospace with dashed rules, so
 * both 80mm thermal rolls and a normal sheet come out exactly as before.
 * Deliberately plain markup + inline styles — no Tailwind state, no images —
 * so it renders the same in every browser and in the desktop shell.
 */
const BillPrintSheet: React.FC<{ order: Order; settings?: CafeSettings }> = ({ order, settings }) => {
  const currency = settings?.currency ?? '';
  const items = Array.isArray(order.items) ? order.items : [];
  const createdAt = order.timeline?.createdAt;
  const timeText = createdAt ? formatOrderTime(createdAt) : '';
  const tableText = order.tableName || (order.tableNumber != null ? `Table ${order.tableNumber}` : '');

  return (
    <div
      id="printable-bill"
      style={{
        fontFamily: 'monospace',
        fontSize: '16px',
        padding: '15px',
        width: '280px',
        margin: '0 auto',
        background: '#fff',
        color: '#000',
        textAlign: 'left',
      }}
    >
      <div style={{ textAlign: 'center', borderBottom: '1px dashed #000', paddingBottom: '8px', marginBottom: '8px' }}>
        <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 'bold', lineHeight: 1.1 }}>
          {settings?.cafeName || 'Bill'}
        </h2>
        {settings?.tagline ? <div>{settings.tagline}</div> : null}
        <div style={{ fontSize: '18px', fontWeight: 'bold', margin: '5px 0' }}>{tableText}</div>
        <div>Order: {order.orderNumber || DASH} | Customer: {order.customerName || 'Guest'}</div>
        <div>Time: {timeText || DASH}</div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', margin: '10px 0' }}>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td style={{ padding: '4px 0', fontStyle: 'italic' }}>No items on this bill</td>
            </tr>
          ) : (
            items.map((it, idx) => (
              <tr key={it?.id ?? `line-${idx}`}>
                <td style={{ padding: '4px 0', fontWeight: 'bold' }}>
                  {/* Plain ASCII text only: some thermal drivers are not UTF-8 safe. */}
                  {it?.quantity ?? 1}x {it?.productName ?? 'Item'}
                  {it?.variantName ? ` (${it.variantName})` : ''}
                </td>
                <td style={{ textAlign: 'right', padding: '4px 0' }}>
                  {currency}
                  {receiptAmount(it?.totalPrice)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {order.specialInstructions ? (
        <div style={{ fontWeight: 'bold', margin: '5px 0' }}>NOTE: {order.specialInstructions}</div>
      ) : null}

      <div
        style={{
          borderTop: '1px dashed #000',
          borderBottom: '1px dashed #000',
          padding: '6px 0',
          fontSize: '16px',
          fontWeight: 'bold',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>TOTAL:</span>
          <span>
            {currency}
            {receiptAmount(order.totalAmount)}
          </span>
        </div>
        <div style={{ fontSize: '12px', fontWeight: 'normal', marginTop: '2px' }}>
          Payment: {(order.paymentStatus || 'unpaid').toUpperCase()}
        </div>
      </div>

      <div style={{ textAlign: 'center', fontSize: '11px', marginTop: '10px' }}>Thank you! Visit Again.</div>
    </div>
  );
};

export const AdminOrders: React.FC<AdminOrdersProps> = ({
  orders,
  settings,
  onRefreshOrders,
  voiceEnabled,
  onToggleVoice,
}) => {
  const [dateFilter, setDateFilter] = useState<'today' | 'active' | 'all'>('today');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedTable, setSelectedTable] = useState<string>('all');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Bill / KOT print job. `null` = no print sheet open.
  const [printJob, setPrintJob] = useState<BillPrintJob | null>(null);
  const printSeq = useRef(0);
  const dialogOpenedForSeq = useRef<number | null>(null);

  // Pinned to the current local calendar day and re-rendered automatically the
  // moment the clock crosses 12:00 AM — that is what makes the "Today's Live"
  // feed reset itself every midnight, even on a dashboard left open for days.
  const today = useToday();

  // Helper to check if order was created today
  const isOrderToday = (dateString?: string) => {
    if (!dateString) return false;
    return isSameLocalDay(dateString, today);
  };

  // Status & Date Filter
  const filteredOrders = orders.filter((order) => {
    // Daily Automatic Filter:
    // 'today': Only orders from today OR any unfinished order still in kitchen (new, cooking, ready)
    if (dateFilter === 'today') {
      const isToday = isOrderToday(order.timeline.createdAt);
      const isStillActive = order.status === 'new' || order.status === 'accepted' || order.status === 'ready';
      if (!isToday && !isStillActive) {
        return false;
      }
    } else if (dateFilter === 'active') {
      const isStillActive = order.status === 'new' || order.status === 'accepted' || order.status === 'ready';
      if (!isStillActive) return false;
    }

    const matchesStatus = selectedStatus === 'all' || order.status === selectedStatus;
    const matchesTable = selectedTable === 'all' || String(order.tableNumber) === selectedTable;
    return matchesStatus && matchesTable;
  });

  const handleUpdateStatus = async (orderId: string, status: OrderStatus) => {
    let cancellationReason: string | undefined = undefined;
    if (status === 'cancelled') {
      const reason = window.prompt('Please enter a cancellation reason:');
      if (reason === null) return; // User cancelled prompt
      cancellationReason = reason.trim() || 'Cancelled by staff';
    }

    try {
      setUpdatingId(orderId);
      await api.adminUpdateOrderStatus(orderId, status, cancellationReason);
      onRefreshOrders();
    } catch (err: any) {
      alert(err?.message || 'Failed to update order status');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleTogglePayment = async (order: Order) => {
    const nextStatus: PaymentStatus = order.paymentStatus === 'paid' ? 'unpaid' : 'paid';
    try {
      setUpdatingId(order.id);
      await api.adminUpdatePaymentStatus(order.id, nextStatus);
      onRefreshOrders();
    } catch (err: any) {
      alert(err?.message || 'Failed to update payment status');
    } finally {
      setUpdatingId(null);
    }
  };

  // ── Print Bill / KOT ─────────────────────────────────────────────────────
  // This used to write the receipt into a `window.open('', '_blank')` popup.
  // A popup is never guaranteed on the POS machine: Chrome can veto it, and
  // the packaged desktop console denies *every* window.open (see
  // `setWindowOpenHandler` in desktop/main.cjs), so `window.open` handed back
  // `null` and staff got an alert instead of a receipt — no print dialog, no
  // way to recover from the browser settings on the floor.
  //
  // The receipt is therefore rendered on this page (#printable-bill) and sent
  // straight to window.print(), which is the popup-free mechanism the QR
  // standee dialog in AdminTables already uses. Nothing new is opened, so
  // nothing can be blocked, and repeated clicks can never pile up windows.
  const closePrintSheet = useCallback(() => {
    setPrintJob(null);
    dialogOpenedForSeq.current = null;
  }, []);

  const handlePrintKOT = useCallback((order?: Order | null) => {
    if (!order || !order.id) {
      // Never fail silently if a card was refreshed away under the click.
      alert('This bill could not be loaded. Please refresh the order list and try again.');
      return;
    }
    printSeq.current += 1;
    setPrintJob({ seq: printSeq.current, order });
  }, []);

  useEffect(() => {
    if (!printJob) {
      document.body.classList.remove('bill-printing');
      return;
    }

    // Scopes the print rules in src/index.css to this sheet only, so printing
    // a bill never changes how anything else in the app prints or looks.
    document.body.classList.add('bill-printing');

    let frame = 0;
    if (dialogOpenedForSeq.current !== printJob.seq) {
      // Two frames: the sheet is committed and painted before the dialog
      // snapshots the page, so a long bill never prints half-rendered.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          if (dialogOpenedForSeq.current === printJob.seq) return;
          dialogOpenedForSeq.current = printJob.seq;
          try {
            window.print();
          } catch {
            alert(
              'The print dialog could not be opened. Please allow pop-ups for this application, or use your browser menu → Print, then tap Print on this bill.'
            );
          }
        });
      });
    }

    // Dismiss the sheet once the dialog is gone (printed or cancelled) so the
    // kitchen feed is exactly where the staff left it. If a browser never
    // fires `afterprint`, the Close button below still works.
    const handleAfterPrint = () => closePrintSheet();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePrintSheet();
    };
    window.addEventListener('afterprint', handleAfterPrint);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', handleAfterPrint);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('bill-printing');
    };
  }, [printJob, closePrintSheet]);

  const todayOrders = orders.filter((o) => isOrderToday(o.timeline.createdAt));
  const activeOrdersCount = orders.filter((o) => o.status === 'new' || o.status === 'accepted' || o.status === 'ready').length;
  const newOrdersCount = orders.filter((o) => o.status === 'new').length;
  const cookingOrdersCount = orders.filter((o) => o.status === 'accepted').length;
  const readyOrdersCount = orders.filter((o) => o.status === 'ready').length;

  const todayFormatted = today.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  return (
    <div className="space-y-4">
      {/* Daily Live Feed Banner & Filter Switcher */}
      <div className="bg-stone-900 text-white p-3 sm:p-4 rounded-2xl border border-stone-800 shadow-md flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-600 flex items-center justify-center text-white shrink-0 shadow-xs">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm sm:text-base font-extrabold text-white tracking-tight">
                Live Kitchen Feed
              </h2>
              <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                {todayFormatted} • Daily Auto-Sync
              </span>
            </div>
            <p className="text-[11px] text-stone-400 font-medium">
              {dateFilter === 'today'
                ? "Showing today's live orders. Yesterday's closed orders are safely archived in Reports."
                : dateFilter === 'active'
                ? "Showing all pending kitchen tickets (New + Cooking + Ready)."
                : "Showing entire historical order database."}
            </p>
          </div>
        </div>

        {/* Date Selector Pills */}
        <div className="flex items-center gap-1.5 bg-stone-950 p-1 rounded-xl border border-stone-800">
          <button
            onClick={() => setDateFilter('today')}
            className={`px-3 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer flex items-center gap-1.5 ${
              dateFilter === 'today'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'text-stone-400 hover:text-white hover:bg-stone-800'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Today's Live ({todayOrders.length})</span>
          </button>

          <button
            onClick={() => setDateFilter('active')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
              dateFilter === 'active'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-400 hover:text-white hover:bg-stone-800'
            }`}
          >
            <ChefHat className="w-3.5 h-3.5" />
            <span>Active Queue ({activeOrdersCount})</span>
          </button>

          <button
            onClick={() => setDateFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              dateFilter === 'all'
                ? 'bg-stone-700 text-white shadow-xs'
                : 'text-stone-400 hover:text-white hover:bg-stone-800'
            }`}
          >
            All History ({orders.length})
          </button>
        </div>
      </div>

      {/* Top Action & Filter Bar */}
      <div className="bg-white p-4 rounded-2xl border border-stone-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        {/* Status Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          <button
            onClick={() => setSelectedStatus('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
              selectedStatus === 'all'
                ? 'bg-stone-900 text-white shadow-xs'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            All in View ({filteredOrders.length})
          </button>
          <button
            onClick={() => setSelectedStatus('new')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap flex items-center gap-1.5 transition-all cursor-pointer ${
              selectedStatus === 'new'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'bg-orange-50 text-orange-950 border border-orange-200 hover:bg-orange-100'
            }`}
          >
            <span>New</span>
            {newOrdersCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center font-black animate-pulse">
                {newOrdersCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setSelectedStatus('accepted')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
              selectedStatus === 'accepted'
                ? 'bg-[#ea580c] text-white shadow-xs'
                : 'bg-orange-50 text-[#c2410c] border border-orange-200 hover:bg-orange-100'
            }`}
          >
            Cooking ({cookingOrdersCount})
          </button>
          <button
            onClick={() => setSelectedStatus('ready')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
              selectedStatus === 'ready'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'bg-emerald-50 text-emerald-900 border border-emerald-200 hover:bg-emerald-100'
            }`}
          >
            Ready ({readyOrdersCount})
          </button>
          <button
            onClick={() => setSelectedStatus('completed')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
              selectedStatus === 'completed'
                ? 'bg-stone-800 text-white shadow-xs'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            Completed
          </button>
        </div>

        {/* Right Tools */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Table Filter Selector */}
          <select
            value={selectedTable}
            onChange={(e) => setSelectedTable(e.target.value)}
            className="px-3 py-1.5 bg-stone-100 border border-stone-200 rounded-xl text-xs font-bold text-stone-800 cursor-pointer focus:ring-2 focus:ring-orange-500"
          >
            <option value="all">All Tables</option>
            {Array.from(new Set(orders.map((o) => o.tableNumber)))
              .sort((a, b) => Number(a) - Number(b))
              .map((tblNum) => (
                <option key={tblNum} value={String(tblNum)}>
                  Table {tblNum} ({orders.filter((o) => o.tableNumber === tblNum).length} orders)
                </option>
              ))}
          </select>

          {/* Spoken-alert toggle, kept in the existing order-toolbar position. */}
          <button
            onClick={onToggleVoice}
            title={voiceEnabled ? 'Spoken order alerts are ON' : 'Spoken order alerts are MUTED'}
            className={`p-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
              voiceEnabled
                ? 'bg-orange-100 border-orange-300 text-orange-950'
                : 'bg-stone-100 border-stone-200 text-stone-500'
            }`}
            aria-label={voiceEnabled ? 'Mute spoken order alerts' : 'Enable spoken order alerts'}
            aria-pressed={voiceEnabled}
          >
            {voiceEnabled ? <Volume2 className="w-4 h-4 text-orange-600" /> : <VolumeX className="w-4 h-4" />}
            <span className="hidden sm:inline">{voiceEnabled ? 'Voice ON' : 'Voice OFF'}</span>
          </button>

          {/* Refresh Button */}
          <button
            onClick={onRefreshOrders}
            className="p-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl border border-stone-200 transition-colors cursor-pointer"
            title="Refresh Orders"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Orders Grid */}
      {filteredOrders.length === 0 ? (
        <div className="bg-white rounded-3xl p-12 text-center border border-stone-200 space-y-2">
          <Clock className="w-10 h-10 text-stone-300 mx-auto" />
          <h3 className="font-bold text-stone-700 text-sm">No orders matching current filter</h3>
          <p className="text-xs text-stone-500">
            Incoming orders from table QR codes will appear here in real-time.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredOrders.map((order) => {
            const isUpdating = updatingId === order.id;
            const waUrl = settings.whatsappNumber
              ? generateWhatsAppOrderUrl(order, settings.whatsappNumber, settings.cafeName, settings.currency)
              : null;

            return (
              <div
                key={order.id}
                id={`admin-order-${order.id}`}
                className={`bg-white rounded-2xl border transition-all duration-200 shadow-sm flex flex-col justify-between overflow-hidden ${
                  order.status === 'new'
                    ? 'border-amber-400 ring-2 ring-amber-400/20'
                    : order.status === 'accepted'
                    ? 'border-orange-300 ring-2 ring-orange-400/20'
                    : order.status === 'ready'
                    ? 'border-emerald-400 ring-2 ring-emerald-400/20'
                    : 'border-stone-200'
                }`}
              >
                {/* Order Top Bar */}
                <div className="p-3.5 bg-stone-50 border-b border-stone-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm text-stone-900">{order.orderNumber}</span>
                    <span className="px-2.5 py-1 rounded-lg bg-orange-600 text-white font-black text-xs shadow-xs tracking-wide">
                      Table {order.tableNumber}
                    </span>
                  </div>

                  {/* Status Pill */}
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-black uppercase tracking-wider ${
                      order.status === 'new'
                        ? 'bg-amber-500 text-white animate-pulse'
                        : order.status === 'accepted'
                        ? 'bg-orange-600 text-white'
                        : order.status === 'ready'
                        ? 'bg-emerald-600 text-white'
                        : order.status === 'completed'
                        ? 'bg-stone-700 text-white'
                        : 'bg-red-600 text-white'
                    }`}
                  >
                    {order.status === 'accepted' ? 'Cooking' : order.status}
                  </span>
                </div>

                {/* Customer Info & Time */}
                <div className="p-3.5 space-y-3 flex-1 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between text-xs text-stone-600 mb-2">
                      <span className="font-bold text-stone-900 flex items-center gap-1">
                        <User className="w-3.5 h-3.5 text-stone-500" />
                        <span>{order.customerName}</span>
                      </span>
                      <span className="text-stone-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>{formatOrderStamp(order.timeline.createdAt, today)}</span>
                      </span>
                    </div>

                    {/* Items Checklist */}
                    <div className="bg-stone-50/80 rounded-xl p-2.5 border border-stone-150 space-y-1.5">
                      {order.items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between text-xs">
                          <div className="font-medium text-stone-800">
                            <span className="font-black text-amber-900 mr-1.5">{item.quantity}×</span>
                            <span>{item.productName}</span>
                            {item.variantName && (
                              <span className="text-[10px] text-stone-500 ml-1">({item.variantName})</span>
                            )}
                          </div>
                          <span className="font-bold text-stone-900">
                            {settings.currency}{item.totalPrice}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Special Instructions Note */}
                    {order.specialInstructions && (
                      <div className="mt-2 p-2 bg-amber-50 rounded-lg text-[11px] text-amber-900 border border-amber-200">
                        <strong>Note:</strong> {order.specialInstructions}
                      </div>
                    )}
                  </div>

                  {/* Pricing & Payment Status Row */}
                  <div className="pt-2 border-t border-stone-100 flex items-center justify-between">
                    <div>
                      <span className="text-[11px] text-stone-500 block">Total Bill</span>
                      <span className="text-base font-black text-amber-950">
                        {settings.currency}{order.totalAmount}
                      </span>
                    </div>

                    {/* Payment Toggle Pill */}
                    <button
                      onClick={() => handleTogglePayment(order)}
                      disabled={isUpdating}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1 border transition-colors ${
                        order.paymentStatus === 'paid'
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                          : 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                      }`}
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      <span>{order.paymentStatus.toUpperCase()}</span>
                    </button>
                  </div>
                </div>

                {/* Action Buttons Bar */}
                <div className="p-3 bg-stone-50 border-t border-stone-100 space-y-2">
                  {/* Primary Lifecycle Transition */}
                  <div className="grid grid-cols-2 gap-1.5">
                    {order.status === 'new' && (
                      <button
                        onClick={() => handleUpdateStatus(order.id, 'accepted')}
                        disabled={isUpdating}
                        className="col-span-2 py-2 px-3 bg-[#ea580c] hover:bg-[#c2410c] text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors shadow-xs cursor-pointer"
                      >
                        <ChefHat className="w-4 h-4" />
                        <span>Accept & Start Cooking</span>
                      </button>
                    )}

                    {order.status === 'accepted' && (
                      <button
                        onClick={() => handleUpdateStatus(order.id, 'ready')}
                        disabled={isUpdating}
                        className="col-span-2 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors shadow-xs"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Mark Food Ready</span>
                      </button>
                    )}

                    {order.status === 'ready' && (
                      <button
                        onClick={() => handleUpdateStatus(order.id, 'completed')}
                        disabled={isUpdating}
                        className="col-span-2 py-2 px-3 bg-amber-950 hover:bg-amber-900 text-amber-300 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors shadow-xs"
                      >
                        <Check className="w-4 h-4" />
                        <span>Complete & Archive</span>
                      </button>
                    )}

                    {order.status === 'completed' && (
                      <div className="col-span-2 py-1.5 px-3 bg-stone-200 text-stone-700 rounded-xl text-xs font-bold text-center">
                        ✓ Completed at {order.timeline.completedAt ? new Date(order.timeline.completedAt).toLocaleTimeString() : ''}
                      </div>
                    )}
                  </div>

                  {/* Secondary Tools: Print KOT, WhatsApp, Cancel */}
                  <div className="flex items-center justify-between gap-1.5 pt-1">
                    <button
                      onClick={() => handlePrintKOT(order)}
                      className="p-1.5 text-stone-600 hover:text-stone-900 hover:bg-stone-200 rounded-lg text-xs font-semibold flex items-center gap-1"
                      title="Print KOT / Bill"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Print</span>
                    </button>

                    {waUrl && (
                      <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50 rounded-lg text-xs font-semibold flex items-center gap-1"
                        title="Send / Open Order on WhatsApp"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>WhatsApp</span>
                      </a>
                    )}

                    {order.status !== 'completed' && order.status !== 'cancelled' && (
                      <button
                        onClick={() => handleUpdateStatus(order.id, 'cancelled')}
                        disabled={isUpdating}
                        className="p-1.5 text-red-600 hover:text-red-800 hover:bg-red-50 rounded-lg text-xs font-semibold flex items-center gap-1 ml-auto"
                        title="Cancel Order"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Cancel</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Print Bill / KOT sheet ──────────────────────────────────────────
          Portalled onto <body> (outside the POS layout) so the print rules can
          isolate the receipt, and so closing it can never disturb the kitchen
          feed underneath. No new window is involved, so nothing is popup
          blocked and repeated clicks reuse this same sheet. */}
      {printJob &&
        createPortal(
          <div
            id="printable-bill-root"
            className="bill-print-shell fixed inset-0 z-50 overflow-y-auto bg-stone-950/75 backdrop-blur-xs flex items-start sm:items-center justify-center p-4 font-sans"
            role="dialog"
            aria-modal="true"
            aria-label={`Print bill ${printJob.order.orderNumber || ''}`.trim()}
          >
            <div className="bill-print-shell bg-white w-full max-w-[360px] rounded-2xl shadow-2xl overflow-hidden border border-[#e7e2dc]">
              {/* Header */}
              <div className="bill-print-chrome p-4 bg-[#1e130c] text-white flex items-center justify-between gap-3 border-b border-[#3a291e]">
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-white tracking-tight truncate">Print Bill / KOT</h3>
                  <p className="text-[11px] text-stone-400 font-medium truncate">
                    {printJob.order.orderNumber || '-'} &bull;{' '}
                    {printJob.order.tableName || (printJob.order.tableNumber != null ? `Table ${printJob.order.tableNumber}` : 'Bill')}
                  </p>
                </div>
                <button
                  onClick={closePrintSheet}
                  title="Close"
                  aria-label="Close print preview"
                  className="p-1.5 rounded-lg hover:bg-[#3a291e] text-stone-300 cursor-pointer shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Receipt preview - #printable-bill is the node @media print keeps */}
              <div className="bill-print-shell p-3 sm:p-4 bg-stone-100 flex justify-center overflow-x-auto">
                <div className="bill-print-shell shadow-sm border border-stone-200">
                  <BillPrintSheet order={printJob.order} settings={settings} />
                </div>
              </div>

              {/* Actions */}
              <div className="bill-print-chrome p-4 bg-white border-t border-[#e7e2dc] space-y-2">
                <button
                  onClick={() => window.print()}
                  className="w-full py-2.5 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-md transition-colors cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Bill</span>
                </button>
                <p className="text-[10px] text-stone-500 leading-relaxed text-center">
                  The print dialog opens by itself. Pick the thermal printer or a normal one - no
                  pop-up permission needed.
                </p>
                <button
                  onClick={closePrintSheet}
                  className="w-full py-2 px-4 bg-[#faf8f5] hover:bg-[#f0ebe1] text-[#6b5d52] font-semibold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-colors cursor-pointer border border-[#e7e2dc]"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Close</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};
