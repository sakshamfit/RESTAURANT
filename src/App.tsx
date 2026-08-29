import React, { useEffect, useState } from 'react';
import {
  Coffee,
  QrCode,
  ShoppingBag,
  ShieldCheck,
  AlertCircle,
  RefreshCw,
  Sparkles,
  UtensilsCrossed,
  ArrowRight,
  ExternalLink,
  Camera,
} from 'lucide-react';
import {
  CafeTable,
  Product,
  CafeCategory,
  CafeSettings,
  CartItem,
  Order,
} from './types';
import { api } from './services/api';
import { Navbar } from './components/Navbar';
import { CustomerMenu } from './components/CustomerMenu';
import { CartDrawer } from './components/CartDrawer';
import { OrderConfirmationModal } from './components/OrderConfirmationModal';
import { OrderStatusTracker } from './components/OrderStatusTracker';
import { AdminLogin } from './components/AdminLogin';
import { AdminDashboard } from './components/AdminDashboard';
import { TableQRScannerModal } from './components/TableQRScannerModal';
import { TableOrderHistoryModal } from './components/TableOrderHistoryModal';
import { playCustomerOrderSuccessSound, sendBrowserNotification, requestNotificationPermission, unlockAudio } from './utils/audioAlerts';
import { saveMyDeviceOrderId } from './utils/deviceOrders';
import { setSupabaseSession } from './lib/supabase';

export default function App() {
  // Navigation & View Mode
  const [isAdminMode, setIsAdminMode] = useState<boolean>(() => {
    return window.location.pathname.startsWith('/admin') || localStorage.getItem('nagori_view_mode') === 'admin';
  });
  const [adminLoggedInEmail, setAdminLoggedInEmail] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState<boolean>(true);

  // Customer Table & Menu State
  const [activeTableToken, setActiveTableToken] = useState<string>(() => {
    return localStorage.getItem('nagori_scanned_table_token') || 'nagori_tbl_tok_table1_9a2f7c';
  });
  const [table, setTable] = useState<CafeTable | null>(null);
  const [settings, setSettings] = useState<CafeSettings | null>(null);
  const [categories, setCategories] = useState<CafeCategory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingMenu, setLoadingMenu] = useState<boolean>(true);
  const [menuError, setMenuError] = useState<string | null>(null);

  // Cart State
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState<boolean>(false);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState<boolean>(false);

  // Order Placement & Live Tracking
  const [confirmedOrder, setConfirmedOrder] = useState<Order | null>(null);
  const [trackingOrderId, setTrackingOrderId] = useState<string | null>(null);

  // QR Scanner & Table Selector & Table Order History
  const [isQRScannerOpen, setIsQRScannerOpen] = useState<boolean>(false);
  const [isTableOrderHistoryOpen, setIsTableOrderHistoryOpen] = useState<boolean>(false);
  const [availableTables, setAvailableTables] = useState<CafeTable[]>([]);

  // 1. Check Path and Admin Auth on mount
  useEffect(() => {
    // Check if path has /order/:token or /table/:token
    const path = window.location.pathname;
    const urlParams = new URLSearchParams(window.location.search);
    const queryTable = urlParams.get('table') || urlParams.get('t') || urlParams.get('token');

    const match = path.match(/^\/(?:order|table)\/([^/]+)/);
    if (match && match[1]) {
      setActiveTableToken(match[1]);
      localStorage.setItem('nagori_scanned_table_token', match[1]);
      setIsAdminMode(false);
    } else if (queryTable) {
      setActiveTableToken(queryTable);
      localStorage.setItem('nagori_scanned_table_token', queryTable);
      setIsAdminMode(false);
    } else if (path.startsWith('/admin') || urlParams.get('admin') === 'true' || urlParams.get('admin') === '1') {
      setIsAdminMode(true);
    }

    // Verify existing admin token if present
    const existingToken = localStorage.getItem('nagori_admin_token');
    if (existingToken) {
      setSupabaseSession(existingToken, localStorage.getItem('nagori_admin_refresh_token') || undefined)
        .catch(() => {})
        .then(() => api.adminGetMe())
        .then((res) => {
          setAdminLoggedInEmail(res.email);
        })
        .catch(() => {
          localStorage.removeItem('nagori_admin_token');
          localStorage.removeItem('nagori_admin_refresh_token');
        })
        .finally(() => {
          setCheckingAuth(false);
        });
    } else {
      setCheckingAuth(false);
    }
  }, []);

  // 2. Fetch Active Table Menu
  const loadMenu = async (tokenOrId: string) => {
    try {
      setLoadingMenu(true);
      setMenuError(null);
      const data = await api.getTableMenu(tokenOrId);
      setTable(data.table);
      setSettings(data.settings);
      setCategories(data.categories);
      setProducts(data.products);
      setActiveTableToken(data.table.token);
      localStorage.setItem('nagori_scanned_table_token', data.table.token);
    } catch (err: any) {
      setMenuError(err?.message || 'Failed to load menu for this table.');
    } finally {
      setLoadingMenu(false);
    }
  };

  useEffect(() => {
    if (!isAdminMode && activeTableToken) {
      loadMenu(activeTableToken);
    }
  }, [activeTableToken, isAdminMode]);

  // Load public tables for the table picker and QR scanner
  const loadPublicTables = async () => {
    try {
      const res = await api.getPublicTables();
      setAvailableTables(res.tables);
    } catch {
      // Fallback
      setAvailableTables([
        { id: 'tbl-1', tableNumber: 1, name: 'Table 1', token: 'nagori_tbl_tok_table1_9a2f7c', isActive: true, createdAt: '' },
        { id: 'tbl-2', tableNumber: 2, name: 'Table 2', token: 'nagori_tbl_tok_table2_4b8e1d', isActive: true, createdAt: '' },
        { id: 'tbl-3', tableNumber: 3, name: 'Table 3', token: 'nagori_tbl_tok_table3_7c3a9f', isActive: true, createdAt: '' },
        { id: 'tbl-4', tableNumber: 4, name: 'Table 4', token: 'nagori_tbl_tok_table4_1f5e8b', isActive: true, createdAt: '' },
        { id: 'tbl-5', tableNumber: 5, name: 'Table 5', token: 'nagori_tbl_tok_table5_3d6a2c', isActive: true, createdAt: '' },
        { id: 'tbl-6', tableNumber: 6, name: 'Table 6', token: 'nagori_tbl_tok_table6_8e0b4f', isActive: true, createdAt: '' },
      ]);
    }
  };

  useEffect(() => {
    loadPublicTables();
  }, []);

  const handleTableDetected = (detectedTokenOrNumber: string) => {
    setActiveTableToken(detectedTokenOrNumber);
    localStorage.setItem('nagori_scanned_table_token', detectedTokenOrNumber);
    loadMenu(detectedTokenOrNumber);
    window.history.pushState({}, '', `/order/${detectedTokenOrNumber}`);
  };

  // Cart Operations
  const handleAddToCart = (item: CartItem) => {
    setCartItems((prev) => {
      const existingIdx = prev.findIndex(
        (i) => i.productId === item.productId && i.variantId === item.variantId
      );
      if (existingIdx > -1) {
        const updated = [...prev];
        updated[existingIdx] = {
          ...updated[existingIdx],
          quantity: updated[existingIdx].quantity + item.quantity,
        };
        return updated;
      }
      return [...prev, item];
    });
  };

  const handleUpdateQuantity = (productId: string, variantId: string | undefined, delta: number) => {
    setCartItems((prev) => {
      return prev
        .map((item) => {
          if (item.productId === productId && item.variantId === variantId) {
            const nextQty = item.quantity + delta;
            return nextQty > 0 ? { ...item, quantity: nextQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[];
    });
  };

  const handleRemoveCartItem = (productId: string, variantId: string | undefined) => {
    setCartItems((prev) =>
      prev.filter((item) => !(item.productId === productId && item.variantId === variantId))
    );
  };

  const handleClearCart = () => {
    setCartItems([]);
  };

  // Submit Customer Order
  const handleSubmitOrder = async (data: {
    customerName: string;
    customerPhone?: string;
    specialInstructions?: string;
  }) => {
    if (!table) return;
    setIsSubmittingOrder(true);
    unlockAudio();
    requestNotificationPermission();

    try {
      const payload = {
        tableToken: table.token,
        tableId: table.id,
        tableNumber: table.tableNumber,
        tableName: table.name,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        specialInstructions: data.specialInstructions,
        items: cartItems.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        })),
      };

      const res = await api.placeOrder(payload);
      setCartItems([]);
      setIsCartOpen(false);
      setConfirmedOrder(res.order);

      // Save order to this phone's device-specific history
      if (res.order?.id) {
        saveMyDeviceOrderId(res.order.id);
      }

      // Play success audio chime & send push/browser notification
      playCustomerOrderSuccessSound();
      sendBrowserNotification(
        `${settings?.cafeName || 'Nagori Chai Point'} • Order Confirmed!`,
        `Order #${res.order.orderNumber} for ${table.name} received and sent to kitchen!`
      );
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  const handleAdminToggle = () => {
    const nextMode = !isAdminMode;
    setIsAdminMode(nextMode);
    localStorage.setItem('nagori_view_mode', nextMode ? 'admin' : 'customer');
    if (nextMode) {
      window.history.pushState({}, '', '/admin');
    } else {
      window.history.pushState({}, '', `/order/${activeTableToken}`);
    }
  };

  const handleAdminLogout = async () => {
    await api.adminLogout();
    setAdminLoggedInEmail(null);
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-4">
        <div className="text-center space-y-3 text-white">
          <div className="w-10 h-10 border-3 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs font-semibold text-stone-400">Initializing Nagori Tea Point...</p>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------
  // ADMIN VIEW
  // ----------------------------------------------------
  if (isAdminMode) {
    if (!adminLoggedInEmail) {
      return (
        <AdminLogin
          onLoginSuccess={(email) => setAdminLoggedInEmail(email)}
          onBackToCustomer={() => {
            setIsAdminMode(false);
            localStorage.setItem('nagori_view_mode', 'customer');
          }}
        />
      );
    }

    return (
      <AdminDashboard
        adminEmail={adminLoggedInEmail}
        onLogout={handleAdminLogout}
        onViewAsCustomer={() => {
          setIsAdminMode(false);
          localStorage.setItem('nagori_view_mode', 'customer');
          window.history.pushState({}, '', `/order/${activeTableToken}`);
        }}
      />
    );
  }

  // ----------------------------------------------------
  // CUSTOMER ORDER STATUS TRACKER VIEW
  // ----------------------------------------------------
  if (trackingOrderId && settings) {
    return (
      <OrderStatusTracker
        orderId={trackingOrderId}
        settings={settings}
        onBackToMenu={() => setTrackingOrderId(null)}
      />
    );
  }

  // ----------------------------------------------------
  // CUSTOMER MENU VIEW
  // ----------------------------------------------------
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col selection:bg-orange-500 selection:text-white">
      {/* Navbar */}
      <Navbar
        currentTable={table}
        cartItems={cartItems}
        onOpenCart={() => setIsCartOpen(true)}
        isAdmin={false}
        onToggleAdmin={handleAdminToggle}
        cafeName={settings?.cafeName || 'Nagori Tea Point'}
        onOpenTableSelect={() => setIsQRScannerOpen(true)}
        onOpenQRScanner={() => setIsQRScannerOpen(true)}
        onOpenOrderHistory={() => setIsTableOrderHistoryOpen(true)}
      />

      {/* Quick Table Change & Order History Banner on Mobile */}
      <div className="bg-stone-900 text-stone-300 text-xs px-3 sm:px-4 py-2 flex items-center justify-between border-b border-stone-800 gap-2">
        <div className="flex items-center gap-2 truncate">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="font-semibold text-white truncate">
            {table ? `Table: ${table.name}` : 'Select / Scan Table'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {table && (
            <button
              onClick={() => setIsTableOrderHistoryOpen(true)}
              className="text-stone-200 hover:text-white font-bold flex items-center gap-1 cursor-pointer bg-stone-800 hover:bg-stone-700 px-2.5 py-1 rounded-lg border border-stone-700 text-[11px] transition-colors shadow-xs"
            >
              <ShoppingBag className="w-3 h-3 text-orange-400" />
              <span>My Orders</span>
            </button>
          )}

          <button
            onClick={() => setIsQRScannerOpen(true)}
            className="text-orange-400 hover:text-orange-300 font-bold flex items-center gap-1 cursor-pointer bg-stone-800 hover:bg-stone-700 px-2.5 py-1 rounded-lg border border-stone-700 text-[11px] transition-colors"
          >
            <Camera className="w-3 h-3 text-orange-400" />
            <span>Scan / Switch</span>
          </button>
        </div>
      </div>

      {/* Loading Menu State */}
      {loadingMenu && !table && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center space-y-3">
            <div className="w-10 h-10 border-3 border-orange-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-bold text-stone-600">Loading Café Menu for {activeTableToken}...</p>
          </div>
        </div>
      )}

      {/* Invalid / Inactive Table QR Error */}
      {menuError && !table && (
        <div className="flex-1 max-w-md mx-auto px-4 py-16 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center mx-auto shadow-sm">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h2 className="text-lg font-bold text-stone-900">QR Code Error</h2>
          <p className="text-xs text-stone-600 leading-relaxed">{menuError}</p>

          <div className="pt-4 flex flex-col gap-2">
            <button
              onClick={() => setIsQRScannerOpen(true)}
              className="py-2.5 px-4 bg-orange-600 text-white rounded-xl text-xs font-bold shadow cursor-pointer flex items-center justify-center gap-2"
            >
              <QrCode className="w-4 h-4" />
              <span>Scan or Select Table</span>
            </button>
            <button
              onClick={() => setIsAdminMode(true)}
              className="py-2.5 px-4 bg-stone-200 text-stone-700 rounded-xl text-xs font-semibold cursor-pointer"
            >
              Go to Café Admin Panel
            </button>
          </div>
        </div>
      )}

      {/* Active Customer Menu */}
      {table && settings && (
        <main className="flex-1">
          <CustomerMenu
            table={table}
            settings={settings}
            categories={categories}
            products={products}
            cartItems={cartItems}
            onAddToCart={handleAddToCart}
            onOpenCart={() => setIsCartOpen(true)}
            onOpenOrderHistory={() => setIsTableOrderHistoryOpen(true)}
            onOpenAdmin={() => setIsAdminMode(true)}
          />
        </main>
      )}

      {/* Cart Drawer */}
      {table && settings && (
        <CartDrawer
          isOpen={isCartOpen}
          onClose={() => setIsCartOpen(false)}
          cartItems={cartItems}
          table={table}
          settings={settings}
          onUpdateQuantity={handleUpdateQuantity}
          onRemoveItem={handleRemoveCartItem}
          onClearCart={handleClearCart}
          onSubmitOrder={handleSubmitOrder}
          isSubmitting={isSubmittingOrder}
        />
      )}

      {/* Order Confirmation Modal */}
      {confirmedOrder && settings && (
        <OrderConfirmationModal
          order={confirmedOrder}
          settings={settings}
          onClose={() => setConfirmedOrder(null)}
          onTrackStatus={() => {
            setTrackingOrderId(confirmedOrder.id);
            setConfirmedOrder(null);
          }}
        />
      )}

      {/* Live In-App Camera QR Scanner & Table Switcher Modal */}
      <TableQRScannerModal
        isOpen={isQRScannerOpen}
        onClose={() => setIsQRScannerOpen(false)}
        onTableDetected={handleTableDetected}
        availableTables={availableTables}
        currentTable={table}
      />

      {/* Table Specific Order History Modal */}
      {table && settings && (
        <TableOrderHistoryModal
          isOpen={isTableOrderHistoryOpen}
          onClose={() => setIsTableOrderHistoryOpen(false)}
          table={table}
          settings={settings}
          onSelectOrderToTrack={(orderId) => {
            setTrackingOrderId(orderId);
            setIsTableOrderHistoryOpen(false);
          }}
        />
      )}
    </div>
  );
}
