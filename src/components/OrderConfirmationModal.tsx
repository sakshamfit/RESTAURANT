import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { CheckCircle2, Clock, MapPin, Receipt, ArrowRight } from 'lucide-react';
import { Order, CafeSettings } from '../types';

interface OrderConfirmationModalProps {
  order: Order;
  settings: CafeSettings;
  onClose: () => void;
  onTrackStatus: () => void;
}

export const OrderConfirmationModal: React.FC<OrderConfirmationModalProps> = ({
  order,
  settings,
  onClose,
  onTrackStatus,
}) => {
  useEffect(() => {
    try {
      confetti({
        particleCount: 70,
        spread: 50,
        origin: { y: 0.6 },
      });
    } catch {
      // Ignore if confetti fails
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#140c07]/75 backdrop-blur-xs font-sans">
      <div className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-[#e7e2dc]">
        {/* Header with Warm Espresso Styling */}
        <div className="bg-[#1e130c] text-white p-6 text-center relative border-b border-[#3d2618]">
          <div className="w-12 h-12 bg-[#2c190e] rounded-full flex items-center justify-center mx-auto mb-3 text-[#ea580c] border border-[#452c1e]">
            <CheckCircle2 className="w-7 h-7" />
          </div>

          <span className="inline-block px-3 py-1 rounded-full bg-[#2c190e] border border-[#452c1e] text-[#fed7aa] text-xs font-semibold mb-2">
            Order Confirmed
          </span>

          <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
            Order Placed Successfully
          </h2>

          <p className="text-xs text-[#e2d9d2] font-normal mt-1 max-w-xs mx-auto">
            The kitchen has received your order and started preparing.
          </p>
        </div>

        {/* Order Details Body */}
        <div className="p-5 sm:p-6 space-y-4 bg-[#faf8f5]">
          {/* Key Badges */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-white rounded-md border border-[#e7e2dc] shadow-xs">
              <span className="text-[10px] font-semibold text-[#78716c] uppercase tracking-wider block">
                Order ID
              </span>
              <span className="text-sm font-bold text-[#1e130c]">
                {order.orderNumber}
              </span>
            </div>

            <div className="p-3 bg-white rounded-md border border-[#e7e2dc] shadow-xs">
              <span className="text-[10px] font-semibold text-[#78716c] uppercase tracking-wider block">
                Table
              </span>
              <span className="text-sm font-bold text-[#1e130c]">
                {order.tableName}
              </span>
            </div>
          </div>

          {/* Customer & Status */}
          <div className="flex items-center justify-between text-xs py-2.5 px-3 bg-white rounded-md border border-[#e7e2dc]">
            <span className="text-[#78716c]">Customer: <strong className="text-[#292524] font-semibold">{order.customerName}</strong></span>
            <span className="font-semibold text-emerald-700 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              <span>Received</span>
            </span>
          </div>

          {/* Itemized Snapshot */}
          <div className="space-y-2 pt-1 bg-white p-3.5 rounded-md border border-[#e7e2dc]">
            <h4 className="text-[11px] font-semibold text-[#78716c] uppercase tracking-wider">
              Items Ordered
            </h4>
            <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
              {order.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between text-xs py-1 border-b border-[#faf8f5]"
                >
                  <div className="text-[#292524] font-medium">
                    <span className="font-bold text-[#1e130c] mr-1.5">{item.quantity}×</span>
                    <span>{item.productName}</span>
                    {item.variantName && (
                      <span className="text-[10px] text-[#78716c] ml-1">({item.variantName})</span>
                    )}
                  </div>
                  <span className="font-semibold text-[#1e130c]">
                    {settings.currency}{item.totalPrice}
                  </span>
                </div>
              ))}
            </div>

            {/* Total */}
            <div className="pt-2 border-t border-[#e7e2dc] flex justify-between items-center">
              <span className="text-xs font-semibold text-[#78716c]">Total Payable</span>
              <span className="text-lg font-bold text-[#1e130c]">
                {settings.currency}{order.totalAmount}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-2">
            <button
              id="view-live-status-btn"
              onClick={onTrackStatus}
              className="w-full py-3 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold rounded-md text-sm shadow-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              <Clock className="w-4 h-4" />
              <span>Track Live Order Status</span>
              <ArrowRight className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className="w-full py-2.5 px-4 bg-white hover:bg-[#faf8f5] border border-[#e7e2dc] text-[#292524] font-semibold rounded-md text-xs transition-colors cursor-pointer"
            >
              Back to Menu
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
