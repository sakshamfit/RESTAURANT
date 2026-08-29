import React, { useEffect, useState, useRef } from 'react';
import {
  Coffee,
  ShoppingBag,
  Utensils,
  QrCode,
  TrendingUp,
  Settings as SettingsIcon,
  LogOut,
  Bell,
  BellRing,
  RefreshCw,
  Eye,
  CheckCircle2,
  Volume2,
  VolumeX,
  Star,
  UserCheck,
} from 'lucide-react';
import { Order, Product, CafeTable, CafeCategory, CafeSettings, WaiterCall } from '../types';
import { api } from '../services/api';
import { subscribeToOrders, subscribeToWaiterCalls } from '../lib/firebase';
import { AdminOrders } from './AdminOrders';
import { AdminProducts } from './AdminProducts';
import { AdminTables } from './AdminTables';
import { AdminReports } from './AdminReports';
import { AdminSettings } from './AdminSettings';
import { AdminWaiterCalls } from './AdminWaiterCalls';
import { AdminFeedbacks } from './AdminFeedbacks';
import { playLoudOrderSiren, stopSiren, unlockAudio } from '../utils/audioAlerts';

interface AdminDashboardProps {
  adminEmail: string;
  onLogout: () => void;
  onViewAsCustomer: () => void;
}

type TabType = 'orders' | 'waiter-calls' | 'feedbacks' | 'products' | 'tables' | 'reports' | 'settings';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  adminEmail,
  onLogout,
  onViewAsCustomer,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('orders');
  const [orders, setOrders] = useState<Order[]>([]);
  const [waiterCalls, setWaiterCalls] = useState<WaiterCall[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<(CafeTable & { activeOrder?: Order | null })[]>([]);
  const [categories, setCategories] = useState<CafeCategory[]>([]);
  const [settings, setSettings] = useState<CafeSettings | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [isSirenActive, setIsSirenActive] = useState<boolean>(false);
  const [sirenMessage, setSirenMessage] = useState<string>('🚨 LIVE LOUD SIREN: NEW ORDER RECEIVED! KITCHEN ALERT!');
  const [loading, setLoading] = useState<boolean>(true);

  const prevOrdersCountRef = useRef<number>(0);
  const prevWaiterCallsCountRef = useRef<number>(0);

  // Trigger loud kitchen siren alert (सायरन)
  const triggerSirenAlert = (msg: string) => {
    if (!soundEnabled) return;
    unlockAudio();
    setSirenMessage(msg);
    setIsSirenActive(true);
    playLoudOrderSiren(5);
    setTimeout(() => {
      setIsSirenActive(false);
    }, 5000);
  };

  const handleTestSiren = () => {
    unlockAudio();
    setSirenMessage('🔔 TEST ALERT: SOUND & SIREN OPERATIONAL');
    setIsSirenActive(true);
    playLoudOrderSiren(3.5);
    setTimeout(() => {
      setIsSirenActive(false);
    }, 3500);
  };

  const handleSilenceSiren = () => {
    stopSiren();
    setIsSirenActive(false);
  };

  const fetchAllData = async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);

      const [ordersRes, waiterCallsRes, productsRes, tablesRes, categoriesRes, settingsRes] = await Promise.all([
        api.adminGetOrders(),
        api.adminGetWaiterCalls(),
        api.adminGetProducts(),
        api.adminGetTables(),
        api.adminGetCategories(),
        api.adminGetSettings(),
      ]);

      const newOrders = ordersRes.orders;
      const newCalls = waiterCallsRes.calls || [];

      // Check if a new order arrived compared to previous count
      const newOrdersCount = newOrders.filter((o) => o.status === 'new').length;
      if (!isInitial && newOrders.length > prevOrdersCountRef.current && newOrdersCount > 0) {
        triggerSirenAlert('🚨 LIVE LOUD SIREN: NEW ORDER RECEIVED! KITCHEN ALERT!');
      }
      prevOrdersCountRef.current = newOrders.length;

      // Check if a new waiter call arrived
      const pendingCalls = newCalls.filter((c) => c.status === 'pending');
      if (!isInitial && pendingCalls.length > prevWaiterCallsCountRef.current) {
        const latestPending = pendingCalls[0];
        triggerSirenAlert(`🔔 WAITER CALLED AT TABLE ${latestPending?.tableNumber || ''}! ASSISTANCE REQUESTED!`);
      }
      prevWaiterCallsCountRef.current = pendingCalls.length;

      setOrders(newOrders);
      setWaiterCalls(newCalls);
      setProducts(productsRes.products);
      setTables(tablesRes.tables);
      setCategories(categoriesRes.categories);
      setSettings(settingsRes.settings);
    } catch (err: any) {
      console.error('Failed to sync admin data:', err);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllData(true);

    // Realtime listeners from Firestore for instant zero-lag kitchen alerts
    const unsubOrders = subscribeToOrders((liveOrders) => {
      if (liveOrders && liveOrders.length > 0) {
        setOrders(liveOrders);
        const newOrdersCount = liveOrders.filter((o) => o.status === 'new').length;
        if (liveOrders.length > prevOrdersCountRef.current && newOrdersCount > 0) {
          triggerSirenAlert('🚨 LIVE LOUD SIREN: NEW ORDER RECEIVED! KITCHEN ALERT!');
        }
        prevOrdersCountRef.current = liveOrders.length;
      }
    });

    const unsubWaiter = subscribeToWaiterCalls((liveCalls) => {
      if (liveCalls) {
        setWaiterCalls(liveCalls);
        const pendingCalls = liveCalls.filter((c) => c.status === 'pending');
        if (pendingCalls.length > prevWaiterCallsCountRef.current) {
          const latestPending = pendingCalls[0];
          triggerSirenAlert(`🔔 WAITER CALLED AT TABLE ${latestPending?.tableNumber || ''}! ASSISTANCE REQUESTED!`);
        }
        prevWaiterCallsCountRef.current = pendingCalls.length;
      }
    });

    // Synchronize every 5 seconds as fallback
    const interval = setInterval(() => {
      fetchAllData(false);
    }, 5000);

    return () => {
      clearInterval(interval);
      if (typeof unsubOrders === 'function') unsubOrders();
      if (typeof unsubWaiter === 'function') unsubWaiter();
      stopSiren();
    };
  }, [soundEnabled]);

  const newOrdersCount = orders.filter((o) => o.status === 'new').length;
  const pendingCallsCount = waiterCalls.filter((c) => c.status === 'pending').length;

  if (loading && !settings) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-4">
        <div className="text-center space-y-3 text-white">
          <div className="w-10 h-10 border-3 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs font-semibold text-stone-400">Loading Café Dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col">
      {/* Top Admin Navigation Header */}
      <header className="bg-stone-950 text-white border-b border-stone-800 sticky top-0 z-30 shadow-md">
        {/* Siren Alert Banner if active */}
        {isSirenActive && (
          <div className="bg-red-600 text-white px-4 py-2 text-xs font-black flex items-center justify-between animate-pulse">
            <div className="flex items-center gap-2">
              <BellRing className="w-4 h-4 animate-bounce shrink-0" />
              <span>{sirenMessage}</span>
            </div>
            <button
              onClick={handleSilenceSiren}
              className="px-2.5 py-0.5 bg-white text-red-700 font-bold rounded hover:bg-stone-100 transition-colors cursor-pointer text-[11px]"
            >
              Mute Siren
            </button>
          </div>
        )}

        {/* Waiter Assistance Alert strip if any table is calling and siren is not active */}
        {!isSirenActive && pendingCallsCount > 0 && (
          <div
            onClick={() => setActiveTab('waiter-calls')}
            className="bg-amber-500 hover:bg-amber-600 text-stone-950 px-4 py-1.5 text-xs font-black flex items-center justify-between cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 animate-bounce text-stone-950" />
              <span>
                🔔 {pendingCallsCount} Table{pendingCallsCount > 1 ? 's are' : ' is'} requesting a Waiter right now! (Click to View Tables)
              </span>
            </div>
            <span className="underline text-[11px] font-extrabold">Open Waiter Screen →</span>
          </div>
        )}

        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          {/* Café Brand & Admin Label */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-orange-600 flex items-center justify-center text-white shadow-md font-bold">
              <Coffee className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-extrabold text-sm sm:text-base text-white tracking-tight leading-none">
                  {settings?.cafeName || 'Nagori Chai Point'}
                </h1>
                <span className="text-[10px] uppercase font-extrabold tracking-wider px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">
                  Admin
                </span>
              </div>
              <p className="text-[11px] text-stone-400 font-mono mt-0.5">{adminEmail}</p>
            </div>
          </div>

          {/* Quick Header Actions */}
          <div className="flex items-center gap-2">
            {/* Siren Audio Test Button */}
            <button
              type="button"
              onClick={handleTestSiren}
              className="py-1.5 px-2.5 rounded-lg bg-red-950/80 hover:bg-red-900 border border-red-800 text-red-300 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Test Loud Siren Sound"
            >
              <BellRing className="w-3.5 h-3.5 text-red-400" />
              <span className="hidden md:inline">Test Loud Siren</span>
              <span className="md:hidden">Siren</span>
            </button>

            {/* Sound Toggle */}
            <button
              type="button"
              onClick={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                if (next) unlockAudio();
              }}
              className={`p-1.5 rounded-lg border text-xs transition-colors cursor-pointer ${
                soundEnabled
                  ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                  : 'bg-stone-800 text-stone-500 border-stone-700'
              }`}
              title={soundEnabled ? 'Order sound siren is ON' : 'Order sound siren is MUTED'}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>

            <button
              onClick={onViewAsCustomer}
              className="py-1.5 px-3 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-semibold flex items-center gap-1.5 border border-stone-700 transition-colors cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5 text-orange-400" />
              <span className="hidden sm:inline">Customer QR View</span>
              <span className="sm:hidden">Customer</span>
            </button>

            <button
              onClick={onLogout}
              className="p-1.5 rounded-lg bg-stone-900 hover:bg-red-950 text-stone-400 hover:text-red-300 border border-stone-800 hover:border-red-800 transition-colors cursor-pointer"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Strip */}
        <div className="max-w-7xl mx-auto px-4 flex items-center gap-1 overflow-x-auto scrollbar-none border-t border-stone-800/80 pt-1">
          {[
            { id: 'orders', label: 'Live Orders', icon: ShoppingBag, badge: newOrdersCount },
            { id: 'waiter-calls', label: 'Waiter Calls', icon: Bell, badge: pendingCallsCount, badgeColor: 'bg-red-600' },
            { id: 'feedbacks', label: 'Ratings & Reviews', icon: Star },
            { id: 'products', label: 'Menu & Products', icon: Utensils },
            { id: 'tables', label: 'Tables & QRs', icon: QrCode },
            { id: 'reports', label: 'Sales & Reports', icon: TrendingUp },
            { id: 'settings', label: 'Café Settings', icon: SettingsIcon },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)}
                className={`py-2.5 px-3.5 text-xs font-bold whitespace-nowrap flex items-center gap-2 border-b-2 transition-all cursor-pointer ${
                  isActive
                    ? 'border-orange-500 text-orange-400 bg-stone-900/60'
                    : 'border-transparent text-stone-400 hover:text-stone-200 hover:bg-stone-900/30'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                {tab.badge && tab.badge > 0 ? (
                  <span className={`px-1.5 py-0.2 rounded-full text-white text-[10px] font-black animate-pulse ${tab.badgeColor || 'bg-orange-600'}`}>
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6">
        {settings && (
          <>
            {activeTab === 'orders' && (
              <AdminOrders
                orders={orders}
                settings={settings}
                onRefreshOrders={() => fetchAllData(false)}
                soundEnabled={soundEnabled}
                onToggleSound={() => setSoundEnabled(!soundEnabled)}
              />
            )}

            {activeTab === 'waiter-calls' && (
              <AdminWaiterCalls
                onRefreshParent={() => fetchAllData(false)}
              />
            )}

            {activeTab === 'feedbacks' && (
              <AdminFeedbacks />
            )}

            {activeTab === 'products' && (
              <AdminProducts
                products={products}
                categories={categories}
                settings={settings}
                onRefresh={() => fetchAllData(false)}
              />
            )}

            {activeTab === 'tables' && (
              <AdminTables
                tables={tables}
                settings={settings}
                onRefresh={() => fetchAllData(false)}
              />
            )}

            {activeTab === 'reports' && (
              <AdminReports settings={settings} />
            )}

            {activeTab === 'settings' && (
              <AdminSettings
                settings={settings}
                adminEmail={adminEmail}
                onRefresh={() => fetchAllData(false)}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};
