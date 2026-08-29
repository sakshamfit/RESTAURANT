import React from 'react';
import { ShoppingBag, ShieldCheck, QrCode, Sparkles } from 'lucide-react';
import { CafeTable, CartItem } from '../types';

interface NavbarProps {
  currentTable: CafeTable | null;
  cartItems: CartItem[];
  onOpenCart: () => void;
  isAdmin: boolean;
  onToggleAdmin: () => void;
  cafeName?: string;
  onOpenTableSelect?: () => void;
  onOpenQRScanner?: () => void;
  onOpenOrderHistory?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTable,
  cartItems,
  onOpenCart,
  isAdmin,
  onToggleAdmin,
  cafeName = 'Nagori Tea Point',
  onOpenTableSelect,
  onOpenQRScanner,
  onOpenOrderHistory,
}) => {
  const totalCartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <header className="sticky top-0 z-30 bg-[#1e130c] text-white border-b border-[#3d2618] shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5 flex items-center justify-between gap-3">
        {/* Brand Logo & Name */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 sm:w-10 sm:h-10 bg-[#ea580c] text-white rounded-md flex items-center justify-center font-bold text-base sm:text-lg shadow-sm">
            N
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="font-semibold text-sm sm:text-lg tracking-tight text-white leading-none">
                {cafeName}
              </h1>
            </div>
            <p className="text-[10px] sm:text-xs font-medium text-[#e2d9d2] tracking-tight mt-0.5">
              Dine-in QR Ordering
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Table Order History Button */}
          {!isAdmin && currentTable && onOpenOrderHistory && (
            <button
              onClick={onOpenOrderHistory}
              title="View My Orders"
              className="bg-[#2c190e] hover:bg-[#3d2618] text-[#e2d9d2] hover:text-white border border-[#452c1e] px-3 py-2 rounded-md flex items-center gap-1.5 transition-colors cursor-pointer text-xs font-semibold"
            >
              <ShoppingBag className="w-3.5 h-3.5 text-[#fb923c]" />
              <span className="hidden sm:inline">My Orders</span>
              <span className="sm:hidden text-[11px]">Orders</span>
            </button>
          )}

          {/* Table Scanner / Selector Button */}
          {!isAdmin && (
            <button
              onClick={onOpenQRScanner || onOpenTableSelect}
              title="Scan Table QR Code or change table"
              className="bg-[#2c190e] hover:bg-[#3d2618] text-white border border-[#452c1e] px-3 py-2 rounded-md flex items-center gap-1.5 transition-colors cursor-pointer text-xs font-semibold"
            >
              <QrCode className="w-3.5 h-3.5 text-[#fb923c]" />
              <span className="hidden sm:inline">
                {currentTable ? currentTable.name : 'Scan QR'}
              </span>
              <span className="sm:hidden text-[11px]">
                {currentTable ? currentTable.name : 'Scan'}
              </span>
            </button>
          )}

          {/* Cart Icon for Customers */}
          {!isAdmin && (
            <button
              id="header-cart-btn"
              onClick={onOpenCart}
              className="relative p-2.5 rounded-md bg-[#ea580c] hover:bg-[#c2410c] text-white font-semibold active:scale-95 transition-all flex items-center justify-center cursor-pointer shadow-sm"
              aria-label="View Cart"
            >
              <ShoppingBag className="w-4 h-4 text-white" />
              {totalCartCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-[#1e130c] text-white border border-[#ea580c] text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shadow-md">
                  {totalCartCount}
                </span>
              )}
            </button>
          )}

          {/* Admin Switcher Button */}
          <button
            id="admin-mode-toggle-btn"
            onClick={onToggleAdmin}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold border transition-all cursor-pointer ${
              isAdmin
                ? 'bg-white text-[#1e130c] border-white shadow-sm'
                : 'bg-[#2c190e] text-[#e2d9d2] border-[#452c1e] hover:text-white hover:bg-[#3d2618]'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#fb923c]" />
            <span className="hidden sm:inline">{isAdmin ? 'Customer View' : 'Café Admin'}</span>
            <span className="sm:hidden text-[11px]">{isAdmin ? 'Customer' : 'Admin'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};


