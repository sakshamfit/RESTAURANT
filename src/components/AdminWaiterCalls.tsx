import React, { useState, useEffect } from 'react';
import { Bell, CheckCircle2, Clock, RefreshCw } from 'lucide-react';
import { WaiterCall } from '../types';
import { api } from '../services/api';
import { useVisiblePolling } from '../utils/usePolling';

interface AdminWaiterCallsProps {
  onRefreshParent?: () => void;
}

export const AdminWaiterCalls: React.FC<AdminWaiterCallsProps> = ({ onRefreshParent }) => {
  const [calls, setCalls] = useState<WaiterCall[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const fetchCalls = async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);
      const res = await api.adminGetWaiterCalls();
      setCalls(res.calls || []);
    } catch (err) {
      console.error('Failed to load waiter calls:', err);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchCalls(true);
  }, []);

  // 4s → 10s, and paused while the tab is hidden. Waiter calls are already
  // announced by the dashboard's own live feed, so this list does not need a
  // sub-5-second cadence of its own.
  useVisiblePolling(() => fetchCalls(false), 10_000);

  const handleAttend = async (id: string) => {
    try {
      setUpdatingId(id);
      await api.adminAttendWaiterCall(id);
      await fetchCalls(false);
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      alert(err?.message || 'Failed to update waiter call.');
    } finally {
      setUpdatingId(null);
    }
  };

  const pendingCalls = calls.filter((c) => c.status === 'pending');
  const displayedCalls = filter === 'pending' ? pendingCalls : calls;


  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="bg-white p-4 sm:p-5 rounded-2xl border border-stone-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-md">
            <Bell className="w-5 h-5 animate-bounce" />
          </div>
          <div>
            <h2 className="font-extrabold text-base sm:text-lg text-stone-900 leading-tight flex items-center gap-2">
              <span>Waiter Assistance Requests</span>
              {pendingCalls.length > 0 && (
                <span className="px-2.5 py-0.5 rounded-full bg-red-600 text-white text-xs font-black animate-pulse">
                  {pendingCalls.length} Waiting
                </span>
              )}
            </h2>
            <p className="text-xs text-stone-500">
              A dashboard banner and a spoken announcement appear the moment a customer presses “Call
              Waiter”. No repeating alarm tone is played.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-stone-100 p-1 rounded-xl border border-stone-200">
            <button
              onClick={() => setFilter('pending')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                filter === 'pending'
                  ? 'bg-stone-900 text-white shadow-xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Pending ({pendingCalls.length})
            </button>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                filter === 'all'
                  ? 'bg-stone-900 text-white shadow-xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              All Calls ({calls.length})
            </button>
          </div>


          <button
            onClick={() => fetchCalls(true)}
            className="p-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl border border-stone-200 transition-colors"
            title="Refresh Waiter Calls"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Live alert status strip — reflects the actual pending-call state. */}
      <div className="bg-white rounded-2xl border border-stone-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-2.5">
          <span
            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
              pendingCalls.length > 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'
            }`}
          >
            <Bell className="w-4 h-4" />
          </span>
          <div>
            <p className="text-xs font-extrabold text-stone-800 flex items-center gap-1.5">
              Waiter Alerts
              <span
                className={`inline-flex items-center gap-1 text-[10px] font-black px-1.5 py-0.5 rounded-full border ${
                  pendingCalls.length > 0
                    ? 'text-red-700 bg-red-50 border-red-200'
                    : 'text-emerald-700 bg-emerald-50 border-emerald-200'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    pendingCalls.length > 0 ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'
                  }`}
                />
                {pendingCalls.length > 0 ? `${pendingCalls.length} PENDING` : 'ALL ATTENDED'}
              </span>
            </p>
            <p className="text-[11px] text-stone-500">
              The dashboard polls this feed every 4 seconds. A banner and one spoken announcement are raised for each
              new call; the banner clears when the table is marked attended.
            </p>
          </div>
        </div>
      </div>

      {/* Grid of Waiter Calls */}
      {displayedCalls.length === 0 ? (
        <div className="bg-white rounded-3xl p-12 text-center border border-stone-200 space-y-2">
          <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-stone-800 text-sm">No Pending Waiter Calls</h3>
          <p className="text-xs text-stone-500 max-w-sm mx-auto">
            All tables are currently attended to. When a customer taps "Call Waiter", you will receive an alert with their table number.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayedCalls.map((call) => {
            const isPending = call.status === 'pending';
            const isUpdating = updatingId === call.id;

            return (
              <div
                key={call.id}
                className={`p-4 sm:p-5 rounded-2xl border transition-all duration-200 shadow-sm flex flex-col justify-between ${
                  isPending
                    ? 'bg-amber-50/70 border-amber-300 ring-2 ring-amber-400/30'
                    : 'bg-white border-stone-200 opacity-80'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <span className="px-3 py-1.5 rounded-xl bg-orange-600 text-white font-black text-sm tracking-wide shadow-xs">
                        TABLE {call.tableNumber}
                      </span>
                      <span className="text-xs font-bold text-stone-700">{call.tableName}</span>
                    </div>

                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                        isPending
                          ? 'bg-red-600 text-white animate-pulse'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {isPending ? 'Needs Waiter' : 'Attended'}
                    </span>
                  </div>

                  <div className="space-y-1 text-xs text-stone-600 mb-4">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-stone-400" />
                      <span>
                        Called at: <strong>{new Date(call.calledAt).toLocaleTimeString()}</strong> (
                        {new Date(call.calledAt).toLocaleDateString()})
                      </span>
                    </div>
                    {call.attendedAt && (
                      <div className="flex items-center gap-1.5 text-emerald-700 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Attended at: {new Date(call.attendedAt).toLocaleTimeString()}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  {isPending ? (
                    <button
                      onClick={() => handleAttend(call.id)}
                      disabled={isUpdating}
                      className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{isUpdating ? 'Marking...' : 'Mark Table Attended'}</span>
                    </button>
                  ) : (
                    <div className="py-2 text-center text-xs font-bold text-stone-500 bg-stone-100 rounded-xl">
                      ✓ Service Completed
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
