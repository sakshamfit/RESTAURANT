import React, { useState } from 'react';
import { X, Plus, Minus, Trash2, ShoppingBag, ArrowRight, User, Phone, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { CartItem, CafeTable, CafeSettings } from '../types';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  table: CafeTable;
  settings: CafeSettings;
  onUpdateQuantity: (productId: string, variantId: string | undefined, delta: number) => void;
  onRemoveItem: (productId: string, variantId: string | undefined) => void;
  onClearCart: () => void;
  onSubmitOrder: (data: {
    customerName: string;
    customerPhone?: string;
    specialInstructions?: string;
  }) => Promise<void>;
  isSubmitting: boolean;
}

export const CartDrawer: React.FC<CartDrawerProps> = ({
  isOpen,
  onClose,
  cartItems,
  table,
  settings,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  onSubmitOrder,
  isSubmitting,
}) => {
  const [customerName, setCustomerName] = useState<string>('');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [specialInstructions, setSpecialInstructions] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!isOpen) return null;

  const totalAmount = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim()) {
      setValidationError('Please enter your name to place the order.');
      return;
    }
    if (cartItems.length === 0) {
      setValidationError('Your order list is empty. Please add items from the menu.');
      return;
    }

    setValidationError(null);
    try {
      await onSubmitOrder({
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim() || undefined,
        specialInstructions: specialInstructions.trim() || undefined,
      });
    } catch (err: any) {
      setValidationError(err?.message || 'Failed to place order.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden font-sans">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[#140c07]/70 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <div className="absolute inset-y-0 right-0 max-w-full flex pl-4 sm:pl-10 w-full sm:max-w-md">
        <div className="w-full bg-[#ffffff] shadow-2xl flex flex-col justify-between overflow-hidden border-l border-[#e7e2dc]">
          {/* Header */}
          <div className="p-5 sm:p-6 bg-[#1e130c] text-white border-b border-[#3d2618] flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold tracking-tight text-white">Your Order</h3>
              <p className="text-xs text-[#e2d9d2] font-medium tracking-tight mt-0.5">
                {settings.cafeName} • {table.name}
              </p>
            </div>

            <button
              id="close-cart-drawer-btn"
              onClick={onClose}
              className="p-2 rounded-md bg-[#2c190e] hover:bg-[#3d2618] text-white transition-colors cursor-pointer border border-[#452c1e]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Cart Body */}
          <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6 bg-[#faf8f5]">
            {validationError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
                <span>{validationError}</span>
              </div>
            )}

            {/* Items List */}
            {cartItems.length === 0 ? (
              <div className="py-16 text-center text-[#78716c] space-y-3">
                <ShoppingBag className="w-10 h-10 mx-auto text-[#a8a29e]" />
                <p className="font-semibold text-[#292524] text-sm">No items in your order yet</p>
                <p className="text-xs text-[#78716c]">
                  Select teas, snacks, and beverages from the menu.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[#78716c]">
                    Selected Items ({totalCount})
                  </h4>
                  <button
                    onClick={onClearCart}
                    className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>

                <div className="space-y-2.5">
                  {cartItems.map((item) => (
                    <div
                      key={`${item.productId}-${item.variantId || 'single'}`}
                      className="flex items-center justify-between gap-3 p-3.5 bg-white rounded-md border border-[#e7e2dc] shadow-xs"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-bold text-xs text-[#78716c]">
                          {item.quantity}×
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-[#292524] truncate">
                            {item.productName}
                          </p>
                          {item.variantName ? (
                            <p className="text-[10px] text-[#ea580c] font-semibold">
                              {item.variantName}
                            </p>
                          ) : (
                            <p className="text-[10px] text-[#78716c]">Regular Size</p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-bold text-[#1e130c] mr-1">
                          {settings.currency}{item.price * item.quantity}
                        </span>

                        {/* Modifiers */}
                        <div className="flex items-center bg-[#faf8f5] border border-[#e7e2dc] rounded-md p-0.5">
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(item.productId, item.variantId, -1)}
                            className="w-5 h-5 flex items-center justify-center rounded-sm text-[#292524] hover:bg-white cursor-pointer"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(item.productId, item.variantId, 1)}
                            className="w-5 h-5 flex items-center justify-center rounded-sm text-[#ea580c] hover:bg-white cursor-pointer font-bold"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => onRemoveItem(item.productId, item.variantId)}
                          className="p-1 text-[#a8a29e] hover:text-red-600 transition-colors cursor-pointer"
                          title="Remove item"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Customer Details Form */}
            {cartItems.length > 0 && (
              <div className="space-y-3 pt-4 border-t border-[#e7e2dc]">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#78716c]">
                  Customer Details
                </h4>

                {/* Name */}
                <div>
                  <label className="block text-xs font-semibold text-[#292524] mb-1 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-[#ea580c]" />
                    <span>Your Name <strong className="text-red-500">*</strong></span>
                  </label>
                  <input
                    id="customer-name-input"
                    type="text"
                    required
                    placeholder="e.g. Rahul Sharma"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-white border border-[#e7e2dc] rounded-md text-sm font-normal text-[#292524] focus:outline-none focus:border-[#ea580c]"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label className="block text-xs font-semibold text-[#78716c] mb-1 flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-[#a8a29e]" />
                    <span>Phone Number (Optional)</span>
                  </label>
                  <input
                    id="customer-phone-input"
                    type="tel"
                    placeholder="e.g. 9876543210"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-white border border-[#e7e2dc] rounded-md text-xs font-normal text-[#292524] focus:outline-none focus:border-[#ea580c]"
                  />
                </div>

                {/* Cooking instructions */}
                <div>
                  <label className="block text-xs font-semibold text-[#78716c] mb-1 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-[#a8a29e]" />
                    <span>Special Instructions</span>
                  </label>
                  <input
                    id="customer-notes-input"
                    type="text"
                    placeholder="e.g. Less sugar, extra crispy"
                    value={specialInstructions}
                    onChange={(e) => setSpecialInstructions(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-white border border-[#e7e2dc] rounded-md text-xs font-normal text-[#292524] focus:outline-none focus:border-[#ea580c]"
                  />
                </div>
              </div>
            )}

            {/* Receipt Summary Breakdown */}
            {cartItems.length > 0 && (
              <div className="pt-4 border-t border-dashed border-[#e7e2dc] space-y-2">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-[#78716c]">Subtotal</span>
                  <span className="text-[#292524] font-semibold">{settings.currency}{totalAmount}</span>
                </div>
                <div className="flex justify-between items-center text-sm text-emerald-700 font-semibold">
                  <span>Taxes & Service Fees</span>
                  <span>Included</span>
                </div>
              </div>
            )}
          </div>

          {/* Footer Checkout CTA */}
          {cartItems.length > 0 && (
            <div className="p-6 bg-white border-t border-[#e7e2dc]">
              <div className="flex justify-between items-end mb-4">
                <p className="text-[#78716c] text-xs font-semibold uppercase tracking-wider">Total Amount</p>
                <p className="text-2xl font-bold text-[#1e130c] tracking-tight leading-none">
                  {settings.currency}{totalAmount}
                </p>
              </div>

              <button
                id="place-order-submit-btn"
                type="button"
                onClick={handlePlaceOrder}
                disabled={isSubmitting || cartItems.length === 0}
                className="w-full bg-[#ea580c] hover:bg-[#c2410c] disabled:bg-[#e7e2dc] disabled:text-[#a8a29e] py-3.5 rounded-md text-white font-bold text-sm shadow-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Placing Order...</span>
                  </>
                ) : (
                  <>
                    <span>Place Dine-In Order</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

