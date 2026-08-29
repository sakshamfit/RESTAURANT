import React, { useState } from 'react';
import { Lock, ShieldCheck, Loader2, AlertCircle, Coffee, Eye, EyeOff, UserCheck } from 'lucide-react';
import { api } from '../services/api';

interface AdminLoginProps {
  onLoginSuccess: (adminEmail: string) => void;
  onBackToCustomer: () => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({
  onLoginSuccess,
  onBackToCustomer,
}) => {
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setError('Please enter the admin password.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      await api.adminLogin('nagori Tea Point', password.trim());
      onLoginSuccess('nagori Tea Point');
    } catch (err: any) {
      setError(err?.message || 'Incorrect admin password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-white border border-[#e7e2dc] rounded-3xl p-6 sm:p-8 shadow-md space-y-6 text-[#1e130c]">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-[#ea580c] text-white flex items-center justify-center mx-auto shadow-md">
            <Coffee className="w-7 h-7" />
          </div>
          <h2 className="text-2xl font-black text-[#1e130c] tracking-tight">
            Admin Access
          </h2>
          <p className="text-xs text-[#6b5d52]">
            Kitchen, Orders & Management Console
          </p>
        </div>

        {/* Locked Admin Account Badge */}
        <div className="p-3.5 bg-[#faf8f5] rounded-2xl border border-[#e7e2dc] flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-orange-100 text-[#ea580c] flex items-center justify-center shrink-0">
            <UserCheck className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-[10px] uppercase font-bold text-[#a89f91] tracking-wider block">
              Admin Account
            </span>
            <p className="text-sm font-bold text-[#1e130c] truncate">
              nagori Tea Point
            </p>
          </div>
          <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full border border-emerald-200">
            Active
          </span>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
            <span>{error}</span>
          </div>
        )}

        {/* Form: Password Only */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-[#1e130c] mb-1.5 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[#ea580c]" />
              <span>Admin Password</span>
            </label>
            <div className="relative">
              <input
                id="admin-password-input"
                type={showPassword ? 'text' : 'password'}
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 pr-11 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-semibold text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c] shadow-xs"
                placeholder="Enter password"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#6b5d52] hover:text-[#1e130c] cursor-pointer"
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            id="admin-login-submit-btn"
            type="submit"
            disabled={loading || !password}
            className="w-full py-3.5 px-4 bg-[#ea580c] hover:bg-[#c2410c] disabled:bg-[#a89f91] text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 transition-all cursor-pointer disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Verifying Password...</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                <span>Login to Admin Dashboard</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-3 text-center border-t border-[#e7e2dc]">
          <button
            type="button"
            onClick={onBackToCustomer}
            className="text-xs font-semibold text-[#6b5d52] hover:text-[#ea580c] transition-colors cursor-pointer"
          >
            ← Return to Customer Ordering View
          </button>
        </div>
      </div>
    </div>
  );
};
