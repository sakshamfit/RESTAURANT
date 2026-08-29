import React, { useState } from 'react';
import { Plus, QrCode, Printer, ExternalLink, Power, Trash2, RefreshCw, AlertCircle, Coffee } from 'lucide-react';
import { CafeTable, Order, CafeSettings } from '../types';
import { api } from '../services/api';
import { QRPrintModal } from './QRPrintModal';

interface AdminTablesProps {
  tables: (CafeTable & { activeOrder?: Order | null })[];
  settings: CafeSettings;
  onRefresh: () => void;
}

export const AdminTables: React.FC<AdminTablesProps> = ({
  tables,
  settings,
  onRefresh,
}) => {
  const [selectedTableForQR, setSelectedTableForQR] = useState<CafeTable | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [newTableNumber, setNewTableNumber] = useState<number>(tables.length + 1);
  const [newTableName, setNewTableName] = useState<string>(`Table ${tables.length + 1}`);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTableNumber) {
      setError('Table number is required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.adminAddTable(newTableNumber, newTableName.trim());
      setIsAddModalOpen(false);
      onRefresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to add table');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tableId: string) => {
    try {
      await api.adminToggleTable(tableId);
      onRefresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to toggle table status');
    }
  };

  const handleRegenerateToken = async (table: CafeTable) => {
    if (
      !window.confirm(
        `Are you sure you want to regenerate the permanent token for ${table.name}? If you already printed physical QR stickers for this table, you will need to print new ones.`
      )
    ) {
      return;
    }
    try {
      await api.adminRegenerateToken(table.id);
      onRefresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to regenerate token');
    }
  };

  const handleDeleteTable = async (table: CafeTable) => {
    if (!window.confirm(`Delete ${table.name}? Active orders may be affected.`)) {
      return;
    }
    try {
      await api.adminDeleteTable(table.id);
      onRefresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to delete table');
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="bg-white p-4 rounded-2xl border border-stone-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-base text-stone-900 leading-tight">
            Tables & Permanent QR Standees
          </h2>
          <p className="text-xs text-stone-500">
            Each table has a permanent QR token. Changing menu items or prices never changes these QR codes.
          </p>
        </div>

        <button
          onClick={() => {
            setNewTableNumber(tables.length + 1);
            setNewTableName(`Table ${tables.length + 1}`);
            setError(null);
            setIsAddModalOpen(true);
          }}
          className="py-2.5 px-4 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs sm:text-sm rounded-xl flex items-center gap-1.5 shadow-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Add New Table</span>
        </button>
      </div>

      {/* Tables Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {tables.map((table) => {
          const hasActiveOrder = Boolean(table.activeOrder);

          return (
            <div
              key={table.id}
              className={`bg-white rounded-2xl border transition-all duration-200 p-5 shadow-xs flex flex-col justify-between ${
                !table.isActive
                  ? 'border-stone-300 opacity-60 bg-stone-50'
                  : hasActiveOrder
                  ? 'border-amber-400 ring-2 ring-amber-400/20'
                  : 'border-stone-200 hover:shadow-md'
              }`}
            >
              {/* Table Top Header */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-amber-950 text-amber-300 flex flex-col items-center justify-center font-black shadow-inner">
                      <span className="text-[10px] uppercase tracking-tighter leading-none">Table</span>
                      <span className="text-xl leading-none">{table.tableNumber}</span>
                    </div>

                    <div>
                      <h3 className="font-bold text-base text-stone-900 leading-tight">
                        {table.name}
                      </h3>
                      <p className="text-[11px] font-mono text-stone-400 truncate max-w-[140px]">
                        {table.token}
                      </p>
                    </div>
                  </div>

                  {/* Status Toggle */}
                  <button
                    onClick={() => handleToggleActive(table.id)}
                    title={table.isActive ? 'Table is Active (Click to disable)' : 'Table is Disabled (Click to activate)'}
                    className={`p-2 rounded-xl border transition-colors ${
                      table.isActive
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100'
                        : 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                    }`}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                </div>

                {/* Active Order Banner */}
                {hasActiveOrder && table.activeOrder && (
                  <div className="mb-3 p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900 flex items-center justify-between">
                    <div>
                      <span className="font-bold">Active: {table.activeOrder.orderNumber}</span>
                      <span className="block text-[11px] text-amber-700">
                        {table.activeOrder.customerName} • {settings.currency}{table.activeOrder.totalAmount}
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded-md bg-amber-200 font-bold text-[10px] uppercase">
                      {table.activeOrder.status}
                    </span>
                  </div>
                )}
              </div>

              {/* Table Action Buttons */}
              <div className="pt-3 border-t border-stone-100 flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSelectedTableForQR(table)}
                    className="py-2 px-3 bg-amber-950 hover:bg-amber-900 text-amber-300 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors shadow-xs"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>View / Print QR</span>
                  </button>

                  <a
                    href={`/order/${table.token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="py-2 px-3 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-xl text-xs font-semibold flex items-center justify-center gap-1 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open Menu</span>
                  </a>
                </div>

                <div className="flex items-center justify-between text-[11px] text-stone-400 pt-1">
                  <button
                    onClick={() => handleRegenerateToken(table)}
                    className="hover:text-amber-800 flex items-center gap-1 font-medium transition-colors"
                    title="Regenerate token if table token was leaked"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Reset Token</span>
                  </button>

                  <button
                    onClick={() => handleDeleteTable(table)}
                    className="hover:text-red-600 flex items-center gap-1 font-medium transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Delete Table</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Table Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden border border-stone-100">
            <div className="p-4 bg-amber-950 text-amber-50 flex items-center justify-between">
              <h3 className="font-bold text-base">Add New Café Table</h3>
            </div>

            <form onSubmit={handleAddTable} className="p-5 space-y-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-700 text-xs font-semibold rounded-xl flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Table Number *
                </label>
                <input
                  type="number"
                  min={1}
                  required
                  value={newTableNumber}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setNewTableNumber(val);
                    setNewTableName(`Table ${val}`);
                  }}
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm font-bold text-stone-900"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-stone-700 mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Table 7, Outdoor 2, AC Cabin 1"
                  value={newTableName}
                  onChange={(e) => setNewTableName(e.target.value)}
                  className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-semibold text-stone-900"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="py-2 px-4 bg-stone-100 text-stone-700 text-xs font-semibold rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="py-2 px-5 bg-amber-600 text-white text-xs font-bold rounded-xl shadow-md"
                >
                  {saving ? 'Creating...' : 'Create Table & QR'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QR Code Standee Print Modal */}
      {selectedTableForQR && (
        <QRPrintModal
          table={selectedTableForQR}
          allTables={tables}
          settings={settings}
          onClose={() => setSelectedTableForQR(null)}
        />
      )}
    </div>
  );
};
