import React, { useState } from 'react';
import { Lock, Mail, ShieldCheck, Loader2, AlertCircle, Coffee, Eye, EyeOff } from 'lucide-react';
import { api } from '../services/api';

interface AdminLoginProps {
  onLoginSuccess: (adminEmail: string) => void;
  onBackToCustomer: () => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({
  onLoginSuccess,
  onBackToCustomer,
}) => {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Please enter both admin email and password.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      await api.adminLogin(email.trim(), password);
      onLoginSuccess(email.trim());
    } catch (err: any) {
      setError(err?.message || 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-white border border-[#e7e2dc] rounded-2xl p-6 sm:p-8 shadow-sm space-y-6 text-[#1e130c]">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-[#ea580c] text-white flex items-center justify-center mx-auto shadow-md">
            <Coffee className="w-6 h-6" />
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#1e130c] tracking-tight">
            Admin Portal
          </h2>
          <p className="text-xs text-[#6b5d52]">
            Nagori Tea Point Management & Kitchen Dashboard
          </p>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
            <span>{error}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#6b5d52] mb-1.5 flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-[#ea580c]" />
              <span>Admin Email</span>
            </label>
            <input
              id="admin-email-input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c]"
              placeholder="admin@nagoriteapoint.com"
              autoComplete="username"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6b5d52] mb-1.5 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[#ea580c]" />
              <span>Password</span>
            </label>
            <div className="relative">
              <input
                id="admin-password-input"
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 pr-10 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c]"
                placeholder="Enter password"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6b5d52] hover:text-[#1e130c] cursor-pointer"
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            id="admin-login-submit-btn"
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-[#ea580c] hover:bg-[#c2410c] disabled:bg-[#6b5d52] text-white font-bold text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition-all cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Verifying credentials...</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                <span>Login to Dashboard</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-2 text-center border-t border-[#e7e2dc]">
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
