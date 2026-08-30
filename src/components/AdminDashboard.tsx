import React, { useEffect, useRef, useState } from 'react';
import {
  Coffee,
  ShoppingBag,
  Utensils,
  QrCode,
  TrendingUp,
  Settings as SettingsIcon,
  LogOut,
  Bell,
  Eye,
  Volume2,
  VolumeX,
  Star,
} from 'lucide-react';
import { Order, Product, CafeTable, CafeCategory, CafeSettings, WaiterCall } from '../types';
import { api, BackendHealth } from '../services/api';
import { AdminOrders } from './AdminOrders';
import { AdminProducts } from './AdminProducts';
import { AdminTables } from './AdminTables';
import { AdminReports } from './AdminReports';
import { AdminSettings } from './AdminSettings';
import { AdminWaiterCalls } from './AdminWaiterCalls';
import { AdminFeedbacks } from './AdminFeedbacks';
import {
  announceOrderReceived,
  prepareOrderVoiceAnnouncements,
  previewOrderVoiceAnnouncement,
  stopOrderVoiceAnnouncements,
} from '../utils/orderVoiceAnnouncements';

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
  const [backendHealth, setBackendHealth] = useState<BackendHealth | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
  const [isVoiceAnnouncementActive, setIsVoiceAnnouncementActive] = useState<boolean>(false);
  const [voiceAnnouncementMessage, setVoiceAnnouncementMessage] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  // We identify incoming orders by their immutable ID, never by a count. That
  // means two tables ordering together are both announced, even if a staff
  // member changes one order's status before the next dashboard refresh.
  const knownOrderIdsRef = useRef<Set<string>>(new Set());
  const hasInitialOrderSnapshotRef = useRef<boolean>(false);
  const dashboardOpenedAtRef = useRef<number>(Date.now());
  const voiceEnabledRef = useRef<boolean>(true);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    if (!voiceEnabled) {
      stopOrderVoiceAnnouncements();
      setIsVoiceAnnouncementActive(false);
    }
  }, [voiceEnabled]);

  const stopVoiceAnnouncement = () => {
    stopOrderVoiceAnnouncements();
    setIsVoiceAnnouncementActive(false);
  };

  const announceOrders = (incomingOrders: Order[]) => {
    if (!voiceEnabledRef.current) return;

    incomingOrders
      .sort((a, b) => new Date(a.timeline.createdAt).getTime() - new Date(b.timeline.createdAt).getTime())
      .forEach((order) => {
        announceOrderReceived(order, {
          onStart: (message) => {
            setVoiceAnnouncementMessage(`AI order voice: ${message}`);
            setIsVoiceAnnouncementActive(true);
          },
          onFinish: () => setIsVoiceAnnouncementActive(false),
        });
      });
  };

  /**
   * The admin all-table order endpoint is read-only. It returns orders from
   * Table 1, Table 2, Table 3, and every table added later; this dashboard
   * only observes the response and never changes saved order data.
   */
  const applyAllTableOrders = (nextOrders: Order[]) => {
    const newlyObserved = nextOrders.filter((order) => !knownOrderIdsRef.current.has(order.id));
    nextOrders.forEach((order) => knownOrderIdsRef.current.add(order.id));

    if (!hasInitialOrderSnapshotRef.current) {
      hasInitialOrderSnapshotRef.current = true;
      // Do not speak old history when staff opens the dashboard. An order made
      // while this first request was loading is still announced so it is not
      // lost in the opening race.
      const receivedWhileOpening = newlyObserved.filter(
        (order) => new Date(order.timeline.createdAt).getTime() >= dashboardOpenedAtRef.current
      );
      announceOrders(receivedWhileOpening);
    } else {
      announceOrders(newlyObserved);
    }

    setOrders(nextOrders);
  };

  const handleTestVoice = () => {
    prepareOrderVoiceAnnouncements();
    const started = previewOrderVoiceAnnouncement({
      onStart: (message) => {
        setVoiceAnnouncementMessage(`AI order voice: ${message}`);
        setIsVoiceAnnouncementActive(true);
      },
      onFinish: () => setIsVoiceAnnouncementActive(false),
    });

    if (!started) {
      setVoiceAnnouncementMessage('AI order voice is unavailable in this browser.');
      setIsVoiceAnnouncementActive(true);
      window.setTimeout(() => setIsVoiceAnnouncementActive(false), 4_000);
    }
  };

  const fetchAllData = async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);

      const [ordersRes, waiterCallsRes, productsRes, tablesRes, categoriesRes, settingsRes] = await Promise.all([
        // No table filter is sent here: this is the all-table source used for
        // live Table 1 / 2 / 3 (and future table) order detection.
        api.adminGetAllTableOrders(),
        api.adminGetWaiterCalls(),
        api.adminGetProducts(),
        api.adminGetTables(),
        api.adminGetCategories(),
        api.adminGetSettings(),
      ]);

      // Backend storage health is informative only — never block the dashboard on it.
      api
        .getHealth()
        .then((health) => setBackendHealth(health))
        .catch(() => setBackendHealth(null));

      applyAllTableOrders(ordersRes.orders);
      setWaiterCalls(waiterCallsRes.calls || []);
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
    prepareOrderVoiceAnnouncements();

    // Most browsers make their full voice list available after a user gesture.
    // This listener never produces audio; it only prepares the feminine voice
    // selection for later automatic incoming-order announcements.
    const warmVoiceList = () => prepareOrderVoiceAnnouncements();
    window.addEventListener('pointerdown', warmVoiceList, { once: true });
    window.addEventListener('keydown', warmVoiceList, { once: true });

    fetchAllData(true);

    // Poll the all-table admin endpoint on the existing dashboard cadence.
    // Polling keeps this compatible with local file storage and serverless
    // deployments while automatically catching orders from every table.
    const interval = window.setInterval(() => {
      fetchAllData(false);
    }, 5_000);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pointerdown', warmVoiceList);
      window.removeEventListener('keydown', warmVoiceList);
      stopOrderVoiceAnnouncements();
    };
  }, []);

  const newOrdersCount = orders.filter((order) => order.status === 'new').length;
  const pendingCallsCount = waiterCalls.filter((call) => call.status === 'pending').length;

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
        {/* The existing alert area is now reserved for the spoken AI order message. */}
        {isVoiceAnnouncementActive && (
          <div
            role="status"
            aria-live="polite"
            className="bg-orange-600 text-white px-4 py-2 text-xs font-black flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 shrink-0" />
              <span>{voiceAnnouncementMessage}</span>
            </div>
            <button
              onClick={stopVoiceAnnouncement}
              className="px-2.5 py-0.5 bg-white text-orange-700 font-bold rounded hover:bg-stone-100 transition-colors cursor-pointer text-[11px]"
            >
              Stop Voice
            </button>
          </div>
        )}

        {/* Waiter requests remain a visual panel notification; they do not play audio. */}
        {!isVoiceAnnouncementActive && pendingCallsCount > 0 && (
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
            {/* Kept in the original header position so the dashboard layout stays unchanged. */}
            <button
              type="button"
              onClick={handleTestVoice}
              className="py-1.5 px-2.5 rounded-lg bg-orange-950/80 hover:bg-orange-900 border border-orange-800 text-orange-300 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Test AI order voice"
            >
              <Volume2 className="w-3.5 h-3.5 text-orange-400" />
              <span className="hidden md:inline">Test AI Voice</span>
              <span className="md:hidden">Voice</span>
            </button>

            {/* Kept in the original header position; it now controls spoken order alerts only. */}
            <button
              type="button"
              onClick={() => setVoiceEnabled((enabled) => !enabled)}
              className={`p-1.5 rounded-lg border text-xs transition-colors cursor-pointer ${
                voiceEnabled
                  ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                  : 'bg-stone-800 text-stone-500 border-stone-700'
              }`}
              title={voiceEnabled ? 'AI order voice is ON' : 'AI order voice is MUTED'}
              aria-label={voiceEnabled ? 'Mute AI order voice' : 'Enable AI order voice'}
              aria-pressed={voiceEnabled}
            >
              {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
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

      {/* Backend Storage Health Banner (informative — shows where data is saved) */}
      {backendHealth && backendHealth.persistence !== 'postgres' && (
        <div
          className={`px-4 py-2.5 text-xs font-semibold border-b flex flex-wrap items-center gap-2 ${
            backendHealth.postgresConfigured
              ? 'bg-red-50 text-red-800 border-red-200'
              : 'bg-amber-50 text-amber-800 border-amber-200'
          }`}
        >
          <span className="w-2 h-2 rounded-full bg-current animate-pulse shrink-0" />
          {backendHealth.postgresConfigured ? (
            <>
              <span>
                ⚠{' '}
                {backendHealth.postgres?.error?.code === '28P01'
                  ? 'Database password rejected'
                  : 'Database is configured but NOT reachable'}{' '}
                — orders &amp; changes are saved to temporary storage and may disappear until this is fixed.
              </span>
              {backendHealth.postgres?.error?.hint && (
                <span className="text-[11px] font-semibold text-red-700 basis-full sm:basis-auto sm:max-w-2xl">
                  {backendHealth.postgres.error.hint}
                </span>
              )}
              {backendHealth.postgres?.error?.message && (
                <span className="text-[11px] font-mono text-red-600 truncate max-w-full">
                  ({backendHealth.postgres.error.code ? `${backendHealth.postgres.error.code} · ` : ''}
                  {backendHealth.postgres.error.message})
                </span>
              )}
            </>
          ) : (
            <span>
              💡 Tip: connect a free PostgreSQL database (<code className="font-mono">DATABASE_URL</code>) in Vercel so
              orders, menu and reports persist permanently. Without it, data resets on redeploys.
            </span>
          )}
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6">
        {settings && (
          <>
            {activeTab === 'orders' && (
              <AdminOrders
                orders={orders}
                settings={settings}
                onRefreshOrders={() => fetchAllData(false)}
                voiceEnabled={voiceEnabled}
                onToggleVoice={() => setVoiceEnabled((enabled) => !enabled)}
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
