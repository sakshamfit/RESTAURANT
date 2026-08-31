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
  BellRing,
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
  announceWaiterCall,
  isSpokenAlertSupported,
  prepareSpokenAlerts,
  stopSpokenAlerts,
} from '../utils/spokenAlerts';

interface AdminDashboardProps {
  adminEmail: string;
  onLogout: () => void;
  onViewAsCustomer: () => void;
}

type TabType = 'orders' | 'waiter-calls' | 'feedbacks' | 'products' | 'tables' | 'reports' | 'settings';

/** Where the staff member's spoken-alert preference is remembered. */
const VOICE_ALERTS_PREF_KEY = 'nagori_voice_alerts';

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
  // Spoken alerts are an operator preference: remembered across reloads and
  // shared with the orders-toolbar toggle.
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(VOICE_ALERTS_PREF_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const [isVoiceAnnouncementActive, setIsVoiceAnnouncementActive] = useState<boolean>(false);
  const [voiceAnnouncementMessage, setVoiceAnnouncementMessage] = useState<string>('');
  const [waiterAlertActive, setWaiterAlertActive] = useState<boolean>(false);
  const [waiterAlertTables, setWaiterAlertTables] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // We identify incoming orders by their immutable ID, never by a count. That
  // means two tables ordering together are both announced, even if a staff
  // member changes one order's status before the next dashboard refresh.
  const knownOrderIdsRef = useRef<Set<string>>(new Set());
  const hasInitialOrderSnapshotRef = useRef<boolean>(false);
  const dashboardOpenedAtRef = useRef<number>(Date.now());
  const voiceEnabledRef = useRef<boolean>(true);

  // Waiter-call detection: track the set of pending call IDs we already know
  // about so only genuinely NEW calls raise an alert (pending calls that were
  // already open before the dashboard loaded do not re-alert).
  const knownPendingCallIdsRef = useRef<Set<string> | null>(null);
  const waiterAlertActiveRef = useRef<boolean>(false);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    try {
      localStorage.setItem(VOICE_ALERTS_PREF_KEY, voiceEnabled ? 'on' : 'off');
    } catch {
      // Private-mode browsers can refuse localStorage; the toggle still works
      // for the current session.
    }
    if (!voiceEnabled) {
      stopSpokenAlerts();
      setIsVoiceAnnouncementActive(false);
    }
  }, [voiceEnabled]);

  const stopVoiceAnnouncement = () => {
    stopSpokenAlerts();
    setIsVoiceAnnouncementActive(false);
  };

  /** Dismiss the waiter-call banner (the call itself stays until attended). */
  const dismissWaiterAlert = React.useCallback(() => {
    waiterAlertActiveRef.current = false;
    setWaiterAlertActive(false);
    setWaiterAlertTables([]);
    stopSpokenAlerts();
    setIsVoiceAnnouncementActive(false);
  }, []);

  /**
   * Raise the waiter-call alert: a persistent banner plus a spoken "Table X is
   * requesting a waiter" announcement. No repeating alarm tone is played — the
   * banner stays until the table is marked attended or staff dismiss it, so
   * the dashboard stays usable on a noisy service floor.
   */
  const raiseWaiterAlert = React.useCallback((newCalls: WaiterCall[]) => {
    if (!voiceEnabledRef.current || newCalls.length === 0) return;

    waiterAlertActiveRef.current = true;
    setWaiterAlertActive(true);

    const tableNames = newCalls
      .map((c) => (c.tableName?.trim() || `Table ${c.tableNumber}`))
      .slice(0, 4);
    setWaiterAlertTables(tableNames);

    const first = newCalls[0];
    announceWaiterCall(
      { tableName: first.tableName, tableNumber: first.tableNumber },
      {
        onStart: (message) => {
          setVoiceAnnouncementMessage(`Waiter call — ${message}`);
          setIsVoiceAnnouncementActive(true);
        },
        onFinish: () => setIsVoiceAnnouncementActive(false),
      }
    );
  }, []);

  const announceOrders = (incomingOrders: Order[]) => {
    if (!voiceEnabledRef.current) return;

    incomingOrders
      .sort((a, b) => new Date(a.timeline.createdAt).getTime() - new Date(b.timeline.createdAt).getTime())
      .forEach((order) => {
        announceOrderReceived(order, {
          onStart: (message) => {
            setVoiceAnnouncementMessage(`Order alert — ${message}`);
            setIsVoiceAnnouncementActive(true);
          },
          onFinish: () => setIsVoiceAnnouncementActive(false),
        });
      });
  };

  /**
   * Observe the waiter-call feed. Only calls that become pending AFTER the
   * first snapshot (i.e. a customer just pressed "Call Waiter") raise an
   * alert. When every pending call is attended, the banner clears itself.
   */
  const applyWaiterCalls = (calls: WaiterCall[]) => {
    const pending = calls.filter((call) => call.status === 'pending');
    const pendingIds = new Set(pending.map((call) => call.id));

    // First snapshot: just record what's already pending, don't re-alarm old calls.
    if (knownPendingCallIdsRef.current === null) {
      knownPendingCallIdsRef.current = pendingIds;
      return;
    }

    const freshPending = pending.filter(
      (call) => !knownPendingCallIdsRef.current!.has(call.id)
    );
    knownPendingCallIdsRef.current = pendingIds;

    if (freshPending.length > 0) {
      raiseWaiterAlert(freshPending);
    } else if (pending.length === 0 && waiterAlertActiveRef.current) {
      // Every table has been attended — clear the banner.
      dismissWaiterAlert();
    }
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

  const spokenAlertsAvailable = isSpokenAlertSupported();

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
      const latestCalls = waiterCallsRes.calls || [];
      setWaiterCalls(latestCalls);
      applyWaiterCalls(latestCalls);
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
    prepareSpokenAlerts();

    // Browsers only allow automatic speech after a user gesture. On the first
    // click/keypress we warm the speech voice list — nothing is spoken, it just
    // arms the later automatic announcements.
    const warmAudio = () => {
      prepareSpokenAlerts();
    };
    window.addEventListener('pointerdown', warmAudio);
    window.addEventListener('keydown', warmAudio);

    fetchAllData(true);

    // Poll the all-table admin endpoint on the existing dashboard cadence.
    // Polling keeps this compatible with local file storage and serverless
    // deployments while automatically catching orders and waiter calls from
    // every table.
    const interval = window.setInterval(() => {
      fetchAllData(false);
    }, 5_000);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pointerdown', warmAudio);
      window.removeEventListener('keydown', warmAudio);
      stopSpokenAlerts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        {/* Waiter-call banner — stays until the table is attended or dismissed. */}
        {waiterAlertActive && (
          <div className="bg-red-600 text-white px-4 py-2 text-xs font-bold flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BellRing className="w-4 h-4 shrink-0" />
              <span>
                {waiterAlertTables.length > 0 ? waiterAlertTables.join(', ') : 'A table'} is requesting a
                waiter.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  dismissWaiterAlert();
                  setActiveTab('waiter-calls');
                }}
                className="px-2.5 py-1 bg-white text-red-700 font-bold rounded hover:bg-stone-100 transition-colors cursor-pointer text-[11px]"
              >
                Attend Table
              </button>
              <button
                onClick={dismissWaiterAlert}
                className="px-2.5 py-1 bg-red-700 text-white font-bold rounded hover:bg-red-800 transition-colors cursor-pointer text-[11px]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Spoken announcement strip (orders + waiter calls). */}
        {isVoiceAnnouncementActive && !waiterAlertActive && (
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

        {/* Persistent reminder for calls still open after the alert is dismissed. */}
        {!waiterAlertActive && pendingCallsCount > 0 && (
          <div
            onClick={() => setActiveTab('waiter-calls')}
            className="bg-amber-500 hover:bg-amber-600 text-stone-950 px-4 py-1.5 text-xs font-bold flex items-center justify-between cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 shrink-0 text-stone-950" />
              <span>
                {pendingCallsCount} table{pendingCallsCount > 1 ? 's are' : ' is'} still waiting for a waiter —
                click to open the waiter screen.
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
            {/* Spoken-alert switch (orders + waiter calls). */}
            <button
              type="button"
              onClick={() => setVoiceEnabled((enabled) => !enabled)}
              className={`p-1.5 rounded-lg border text-xs transition-colors cursor-pointer ${
                voiceEnabled
                  ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
                  : 'bg-stone-800 text-stone-500 border-stone-700'
              }`}
              title={
                !spokenAlertsAvailable
                  ? 'Spoken alerts are not supported by this browser'
                  : voiceEnabled
                    ? 'Spoken order and waiter alerts are ON'
                    : 'Spoken order and waiter alerts are MUTED'
              }
              aria-label={voiceEnabled ? 'Mute spoken alerts' : 'Enable spoken alerts'}
              aria-pressed={voiceEnabled}
              disabled={!spokenAlertsAvailable}
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
