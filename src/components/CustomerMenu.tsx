import React, { useState, useMemo } from 'react';
import { Search, ShoppingBag, ArrowRight, UtensilsCrossed, Bell, CheckCircle2, QrCode, Loader2, Volume2, Sparkles } from 'lucide-react';
import { Product, CafeCategory, CafeTable, CartItem, CafeSettings } from '../types';
import { ProductCard } from './ProductCard';
import { api } from '../services/api';
import { unlockAudio } from '../utils/audioAlerts';

interface CustomerMenuProps {
  table: CafeTable;
  settings: CafeSettings;
  categories: CafeCategory[];
  products: Product[];
  cartItems: CartItem[];
  onAddToCart: (item: CartItem) => void;
  onOpenCart: () => void;
  onOpenOrderHistory?: () => void;
  onOpenAdmin?: () => void;
}

const CATEGORY_ICONS: Record<string, string> = {
  'Tea & Coffee': '☕',
  'Snacks': '🥟',
  'Burgers': '🍔',
  'Momos': '🥟',
  'Chinese': '🍜',
  'Beverages': '🥤',
};

export const CustomerMenu: React.FC<CustomerMenuProps> = ({
  table,
  settings,
  categories,
  products,
  cartItems,
  onAddToCart,
  onOpenCart,
  onOpenOrderHistory,
  onOpenAdmin,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isCallingWaiter, setIsCallingWaiter] = useState<boolean>(false);
  const [waiterCalled, setWaiterCalled] = useState<boolean>(false);
  const [waiterNotice, setWaiterNotice] = useState<string | null>(null);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesCategory = selectedCategory === 'all' || p.category === selectedCategory;
      const matchesSearch =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.category.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [products, selectedCategory, searchQuery]);

  const totalCartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalCartAmount = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const handleCallWaiter = async () => {
    if (isCallingWaiter) return;
    try {
      setIsCallingWaiter(true);
      unlockAudio();
      await api.callWaiter({
        tableToken: table.token,
        tableId: table.id,
        tableNumber: table.tableNumber,
        tableName: table.name,
        customerName: 'Customer at ' + table.name,
      });

      setWaiterCalled(true);
      setWaiterNotice(`🔔 Waiter requested for ${table.name}! Staff will arrive at your table shortly.`);

      // Reset button state after a period
      setTimeout(() => {
        setWaiterCalled(false);
      }, 10000);
      setTimeout(() => {
        setWaiterNotice(null);
      }, 7000);
    } catch (err: any) {
      alert(err?.message || 'Unable to alert waiter. Please ask staff directly.');
    } finally {
      setIsCallingWaiter(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#faf8f5] text-[#292524] flex flex-col font-sans pb-28 lg:pb-12">
      {/* Editorial Dark Hero Band */}
      <section className="bg-[#1e130c] text-white hero-backdrop-atmospheric border-b border-[#3d2618] px-4 sm:px-8 py-8 sm:py-12">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
          {/* Left Column: Atmospheric Typography */}
          <div className="max-w-2xl space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#2c190e] border border-[#452c1e] text-[#fed7aa] text-xs font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-[#f97316] animate-pulse" />
              <span>Ordering from {table.name}</span>
            </div>

            <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight text-white leading-[1.05]">
              {settings.cafeName}
            </h1>

            <p className="text-sm sm:text-base text-[#e2d9d2] font-normal max-w-xl leading-relaxed">
              {settings.tagline || 'Artisanal teas, fresh snacks, and table-side dine-in service.'}
            </p>
          </div>

          {/* Right Column: Waiter & Status Pill */}
          <div className="flex flex-row md:flex-col items-start md:items-end gap-3 shrink-0">
            <div className="bg-[#2c190e] border border-[#452c1e] rounded-lg p-3 text-left w-full sm:w-auto">
              <div className="flex items-center justify-between gap-4 mb-2">
                <span className="text-[11px] font-medium text-[#e2d9d2]">Dine-In Station</span>
                <span className="text-xs font-bold text-[#fed7aa] bg-[#1e130c] px-2 py-0.5 rounded border border-[#452c1e]">
                  {table.name}
                </span>
              </div>

              <button
                onClick={handleCallWaiter}
                disabled={isCallingWaiter || waiterCalled}
                className={`w-full py-2.5 px-4 rounded-full text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs ${
                  waiterCalled
                    ? 'bg-emerald-600 text-white'
                    : isCallingWaiter
                    ? 'bg-orange-700 text-white opacity-80'
                    : 'bg-[#ea580c] hover:bg-[#c2410c] text-white'
                }`}
              >
                {isCallingWaiter ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Calling Staff...</span>
                  </>
                ) : waiterCalled ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Waiter Notified ✓</span>
                  </>
                ) : (
                  <>
                    <Bell className="w-3.5 h-3.5" />
                    <span>Call Waiter</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Floating Waiter Call Toast Alert */}
      {waiterNotice && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-md animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="bg-emerald-700 text-white p-4 rounded-2xl shadow-2xl border border-emerald-500/50 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
              <Bell className="w-5 h-5 animate-bounce" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold leading-snug">{waiterNotice}</p>
              <p className="text-[10px] text-emerald-100 mt-0.5">Assistance is on the way to your table.</p>
            </div>
            <button
              onClick={() => setWaiterNotice(null)}
              className="px-2 py-1 bg-white/20 hover:bg-white/30 text-white text-xs font-bold rounded-lg cursor-pointer"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Main Content Layout */}
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-8 pt-8 flex-1 flex flex-col lg:flex-row gap-8">
        {/* Desktop Sidebar: Category Selection */}
        <aside className="hidden lg:flex w-64 flex-col gap-2 shrink-0">
          <h3 className="text-xs font-semibold text-[#78716c] uppercase tracking-wider mb-2 px-2">
            Categories
          </h3>

          <button
            type="button"
            onClick={() => setSelectedCategory('all')}
            className={`flex items-center justify-between w-full p-3 rounded-lg font-semibold text-sm transition-all text-left cursor-pointer ${
              selectedCategory === 'all'
                ? 'bg-[#1e130c] text-white shadow-sm'
                : 'text-[#292524] hover:bg-white bg-transparent border border-transparent hover:border-[#e7e2dc]'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <span>✨</span>
              <span>All Items</span>
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${selectedCategory === 'all' ? 'bg-[#ea580c] text-white' : 'bg-[#e7e2dc] text-[#78716c]'}`}>
              {products.length}
            </span>
          </button>

          {categories.map((cat) => {
            const isSelected = selectedCategory === cat.name;
            const count = products.filter((p) => p.category === cat.name).length;
            const icon = CATEGORY_ICONS[cat.name] || '🍽️';

            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.name)}
                className={`flex items-center justify-between w-full p-3 rounded-lg font-semibold text-sm transition-all text-left cursor-pointer ${
                  isSelected
                    ? 'bg-[#1e130c] text-white shadow-sm'
                    : 'text-[#292524] hover:bg-white bg-transparent border border-transparent hover:border-[#e7e2dc]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span>{icon}</span>
                  <span>{cat.name}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${isSelected ? 'bg-[#ea580c] text-white' : 'bg-[#e7e2dc] text-[#78716c]'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </aside>

        {/* Product Grid & Search */}
        <section className="flex-1 space-y-6">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#78716c]" />
            <input
              id="customer-menu-search"
              type="text"
              placeholder="Search items, beverages, snacks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white border border-[#e7e2dc] rounded-md text-sm font-normal text-[#292524] placeholder:text-[#a8a29e] focus:outline-none focus:border-[#ea580c] shadow-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-[#78716c] hover:text-[#292524] font-semibold cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>

          {/* Mobile Categories Horizontal Strip */}
          <div className="flex lg:hidden items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
            <button
              type="button"
              onClick={() => setSelectedCategory('all')}
              className={`px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                selectedCategory === 'all'
                  ? 'bg-[#1e130c] text-white'
                  : 'bg-white text-[#292524] border border-[#e7e2dc] hover:bg-[#faf8f5]'
              }`}
            >
              All Items ({products.length})
            </button>
            {categories.map((cat) => {
              const isSelected = selectedCategory === cat.name;
              const count = products.filter((p) => p.category === cat.name).length;
              const icon = CATEGORY_ICONS[cat.name] || '🍽️';

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategory(cat.name)}
                  className={`px-4 py-2 rounded-full text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 cursor-pointer ${
                    isSelected
                      ? 'bg-[#1e130c] text-white'
                      : 'bg-white text-[#292524] border border-[#e7e2dc] hover:bg-[#faf8f5]'
                  }`}
                >
                  <span>{icon}</span>
                  <span>{cat.name} {count > 0 ? `(${count})` : ''}</span>
                </button>
              );
            })}
          </div>

          {/* Products Grid */}
          {filteredProducts.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
              {filteredProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  currency={settings.currency}
                  onAddToCart={onAddToCart}
                />
              ))}
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-[#e7e2dc] p-12 text-center my-6 shadow-xs">
              <div className="w-12 h-12 rounded-md bg-[#faf8f5] border border-[#e7e2dc] flex items-center justify-center mx-auto mb-3 text-[#78716c]">
                <UtensilsCrossed className="w-5 h-5" />
              </div>
              <h3 className="font-semibold text-[#292524] text-base mb-1">No items found</h3>
              <p className="text-[#78716c] text-xs max-w-xs mx-auto">
                We couldn't find anything matching "{searchQuery}". Try a different search term or category.
              </p>
            </div>
          )}
        </section>
      </div>

      {/* Signature Warm Orange Closing CTA Band */}
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-8 mt-16">
        <div className="bg-[#1e130c] text-white rounded-lg p-8 sm:p-12 orange-backdrop-atmospheric border border-[#3d2618] flex flex-col md:flex-row items-center justify-between gap-6 shadow-sm">
          <div className="space-y-2 text-center md:text-left">
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white leading-snug">
              Fast, contactless dine-in ordering.
            </h2>
            <p className="text-sm text-[#e2d9d2] max-w-lg">
              Place orders directly from your phone. Items are prepared fresh and served straight to {table.name}.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {totalCartCount > 0 ? (
              <button
                onClick={onOpenCart}
                className="bg-[#ea580c] hover:bg-[#c2410c] text-white px-5 py-3 rounded-md font-bold text-sm transition-all shadow-sm flex items-center gap-2 cursor-pointer"
              >
                <ShoppingBag className="w-4 h-4" />
                <span>View My Order ({totalCartCount})</span>
              </button>
            ) : (
              <button
                onClick={handleCallWaiter}
                className="bg-white text-[#1e130c] hover:bg-[#faf8f5] px-5 py-3 rounded-md font-bold text-sm transition-all shadow-sm flex items-center gap-2 cursor-pointer"
              >
                <Bell className="w-4 h-4 text-[#ea580c]" />
                <span>Call Table Waiter</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Footer info */}
      <footer className="max-w-7xl w-full mx-auto px-4 sm:px-8 mt-12 pt-6 border-t border-[#e7e2dc] text-center text-xs text-[#78716c] flex flex-col sm:flex-row items-center justify-between gap-2">
        <p>© {new Date().getFullYear()} {settings.cafeName}. All rights reserved.</p>
        {onOpenAdmin && (
          <button
            onClick={onOpenAdmin}
            className="text-[11px] text-[#a89f91] hover:text-[#78716c] transition-colors cursor-pointer"
            title="Management Access"
          >
            Owner / Staff Login
          </button>
        )}
      </footer>

      {/* Floating Bottom Sticky Cart Bar on Mobile/Tablet */}
      {totalCartCount > 0 && (
        <div className="fixed bottom-4 left-0 right-0 z-20 px-4">
          <div className="max-w-md mx-auto">
            <button
              id="floating-checkout-btn"
              onClick={onOpenCart}
              className="w-full bg-[#1e130c] hover:bg-[#140c07] text-white rounded-md p-3.5 shadow-xl border border-[#3d2618] flex items-center justify-between transition-all transform active:scale-98 cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-md bg-[#ea580c] text-white flex items-center justify-center font-bold text-xs">
                  {totalCartCount}
                </div>
                <div className="text-left">
                  <p className="text-[11px] tracking-tight text-[#e2d9d2] font-medium">
                    {totalCartCount} {totalCartCount === 1 ? 'item' : 'items'} in order
                  </p>
                  <p className="text-base font-semibold leading-tight text-white">
                    {settings.currency}{totalCartAmount}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-xs font-semibold bg-[#ea580c] text-white px-3.5 py-2 rounded-md shadow-xs">
                <span>View Order</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

