import React, { useEffect, useState } from 'react';
import {
  TrendingUp,
  ShoppingBag,
  DollarSign,
  Calendar,
  Download,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles,
} from 'lucide-react';
import { SalesSummary, CafeSettings } from '../types';
import { api } from '../services/api';

interface AdminReportsProps {
  settings: CafeSettings;
}

export const AdminReports: React.FC<AdminReportsProps> = ({ settings }) => {
  const [range, setRange] = useState<string>('today');
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchReports = async (selectedRange: string) => {
    try {
      setLoading(true);
      const data = await api.adminGetReports(selectedRange);
      setSummary(data.summary);
    } catch (err: any) {
      console.error('Failed to load reports:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(range);
  }, [range]);

  const handleExportCSV = () => {
    if (!summary || summary.recentOrders.length === 0) {
      alert('No order data to export for selected range.');
      return;
    }

    const headers = ['Order Number', 'Date Time', 'Table', 'Customer', 'Items', 'Total Amount', 'Status', 'Payment Status'];
    const rows = summary.recentOrders.map((o) => [
      o.orderNumber,
      new Date(o.timeline.createdAt).toLocaleString(),
      o.tableName,
      `"${o.customerName}"`,
      `"${o.items.map((i) => `${i.quantity}x ${i.productName}`).join(', ')}"`,
      o.totalAmount,
      o.status,
      o.paymentStatus,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Nagori_Tea_Point_Sales_Report_${range}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-5">
      {/* Top Range Selector Bar */}
      <div className="bg-white p-4 rounded-2xl border border-stone-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {[
            { id: 'today', label: 'Today' },
            { id: 'yesterday', label: 'Yesterday' },
            { id: 'week', label: 'Last 7 Days' },
            { id: 'month', label: 'This Month' },
            { id: 'all', label: 'All Time' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setRange(item.id)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                range === item.id
                  ? 'bg-amber-950 text-white shadow-xs'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          onClick={handleExportCSV}
          className="py-2 px-3.5 bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export CSV</span>
        </button>
      </div>

      {/* KPI Cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
          {/* Revenue */}
          <div className="bg-white p-4 sm:p-5 rounded-2xl border border-stone-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-xs font-bold uppercase tracking-wider">Completed Sales</span>
              <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
                <DollarSign className="w-4 h-4" />
              </div>
            </div>
            <p className="text-2xl font-black text-stone-900">
              {settings.currency}{summary.totalRevenue}
            </p>
            <p className="text-[11px] text-stone-500 font-medium">
              From {summary.completedOrders} completed orders
            </p>
          </div>

          {/* Total Orders */}
          <div className="bg-white p-4 sm:p-5 rounded-2xl border border-stone-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-xs font-bold uppercase tracking-wider">Total Orders</span>
              <div className="w-8 h-8 rounded-lg bg-orange-100 text-[#ea580c] flex items-center justify-center font-bold">
                <ShoppingBag className="w-4 h-4" />
              </div>
            </div>
            <p className="text-2xl font-black text-stone-900">
              {summary.totalOrders}
            </p>
            <div className="flex items-center gap-2 text-[11px] font-medium text-stone-500">
              <span className="text-emerald-700 font-bold">{summary.completedOrders} Done</span>
              <span>•</span>
              <span className="text-red-600 font-bold">{summary.cancelledOrders} Cancelled</span>
            </div>
          </div>

          {/* Average Ticket Size */}
          <div className="bg-white p-4 sm:p-5 rounded-2xl border border-stone-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-xs font-bold uppercase tracking-wider">Avg Order Value</span>
              <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center font-bold">
                <TrendingUp className="w-4 h-4" />
              </div>
            </div>
            <p className="text-2xl font-black text-stone-900">
              {settings.currency}{summary.averageOrderValue}
            </p>
            <p className="text-[11px] text-stone-500 font-medium">
              Per completed bill
            </p>
          </div>

          {/* Collection Status */}
          <div className="bg-white p-4 sm:p-5 rounded-2xl border border-stone-200 shadow-xs space-y-1">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-xs font-bold uppercase tracking-wider">Paid / Unpaid</span>
              <div className="w-8 h-8 rounded-lg bg-purple-100 text-purple-800 flex items-center justify-center font-bold">
                <CheckCircle2 className="w-4 h-4" />
              </div>
            </div>
            <p className="text-2xl font-black text-emerald-700">
              {settings.currency}{summary.paidAmount}
            </p>
            <p className="text-[11px] text-amber-700 font-bold">
              Unpaid Pending: {settings.currency}{summary.unpaidAmount}
            </p>
          </div>
        </div>
      )}

      {/* Best Selling Dishes Breakdown */}
      {summary && (
        <div className="bg-white rounded-3xl p-5 border border-stone-200 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-base text-stone-900 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-600" />
                <span>Best Selling Menu Items</span>
              </h3>
              <p className="text-xs text-stone-500">
                Sorted by units ordered during selected timeframe.
              </p>
            </div>
          </div>

          {summary.topSellingItems.length === 0 ? (
            <p className="text-xs text-stone-400 py-6 text-center">
              No sales data recorded in this period yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-stone-150 text-stone-500 uppercase tracking-wider font-bold">
                    <th className="py-2.5 px-3">#</th>
                    <th className="py-2.5 px-3">Dish / Item Name</th>
                    <th className="py-2.5 px-3">Variant</th>
                    <th className="py-2.5 px-3 text-right">Quantity Sold</th>
                    <th className="py-2.5 px-3 text-right">Total Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {summary.topSellingItems.map((item, index) => (
                    <tr key={index} className="hover:bg-stone-50 transition-colors">
                      <td className="py-2.5 px-3 font-bold text-stone-400">{index + 1}</td>
                      <td className="py-2.5 px-3 font-bold text-stone-900">{item.name}</td>
                      <td className="py-2.5 px-3 text-stone-600">
                        {item.variant ? (
                          <span className="px-2 py-0.5 rounded bg-stone-100 text-stone-700 font-semibold text-[10px]">
                            {item.variant}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-black text-amber-900 text-right">
                        {item.quantity} pcs
                      </td>
                      <td className="py-2.5 px-3 font-black text-stone-900 text-right">
                        {settings.currency}{item.revenue}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
