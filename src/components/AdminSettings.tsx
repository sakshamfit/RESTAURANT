import React, { useEffect, useState } from 'react';
import {
  Settings,
  MessageSquare,
  Lock,
  Building,
  DollarSign,
  Save,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Shield,
  Volume2,
  Monitor,
  FolderOpen,
  Key,
  RefreshCw,
  Download,
  Copy,
  Calendar,
} from 'lucide-react';
import { CafeSettings } from '../types';
import { api } from '../services/api';
import type { NagoriDesktopInfo } from '../desktop';
import { licenseService, getMachineFingerprint, type LicenseStatusResponse } from '../services/license';

interface AdminSettingsProps {
  settings: CafeSettings;
  adminEmail: string;
  onRefresh: () => void;
}

export const AdminSettings: React.FC<AdminSettingsProps> = ({
  settings,
  adminEmail,
  onRefresh,
}) => {
  // Café Settings Form
  const [formData, setFormData] = useState<CafeSettings>({ ...settings });
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Change Password Form
  const [currentPassword, setCurrentPassword] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState<boolean>(false);

  // Present only inside the packaged desktop app (window.nagoriDesktop is
  // injected by its preload script; never present in a browser).
  const [desktopInfo, setDesktopInfo] = useState<NagoriDesktopInfo | null>(null);
  useEffect(() => {
    if (!window.nagoriDesktop?.isDesktop) return;
    window.nagoriDesktop.getInfo().then(setDesktopInfo).catch(() => setDesktopInfo(null));
  }, []);

  // License / subscription state. The card is only shown when the build is
  // a distributed one (licenseRequired=true). Self-hosted builds hide it.
  const [license, setLicense] = useState<LicenseStatusResponse | null>(null);
  const [rebindOpen, setRebindOpen] = useState<boolean>(false);
  const [rebindEmail, setRebindEmail] = useState<string>('');
  const [rebindKey, setRebindKey] = useState<string>('');
  const [rebindError, setRebindError] = useState<string | null>(null);
  const [rebindSubmitting, setRebindSubmitting] = useState<boolean>(false);
  const [rebindSuccess, setRebindSuccess] = useState<boolean>(false);
  const [heartbeatRunning, setHeartbeatRunning] = useState<boolean>(false);
  const [fingerprintCopied, setFingerprintCopied] = useState<boolean>(false);
  const [auditOpen, setAuditOpen] = useState<boolean>(false);
  const [auditEntries, setAuditEntries] = useState<Array<{ ts: string; admin: string; fingerprint: string; method: string; path: string }> | null>(null);

  useEffect(() => {
    if (!auditOpen || auditEntries !== null) return;
    api.adminGetAudit(200).then((r) => setAuditEntries(r.entries)).catch(() => setAuditEntries([]));
  }, [auditOpen, auditEntries]);

  const refreshLicense = React.useCallback(async () => {
    try {
      const s = await licenseService.getStatus();
      setLicense(s);
    } catch {
      setLicense(null);
    }
  }, []);

  useEffect(() => {
    refreshLicense();
    // Heartbeat once on mount so the dashboard reflects the latest server
    // state (e.g. "renewed yesterday").
    void licenseService
      .heartbeat()
      .then((r) => setLicense({ licenseRequired: true, status: r.status }))
      .catch(() => undefined);
  }, [refreshLicense]);

  const handleHeartbeat = async () => {
    setHeartbeatRunning(true);
    try {
      const r = await licenseService.heartbeat();
      setLicense({ licenseRequired: true, status: r.status });
    } catch {
      // best effort
    } finally {
      setHeartbeatRunning(false);
    }
  };

  const handleRebind = async (e: React.FormEvent) => {
    e.preventDefault();
    setRebindError(null);
    setRebindSuccess(false);
    if (!rebindKey.trim() || !rebindEmail.trim()) {
      setRebindError('License key and email are both required.');
      return;
    }
    setRebindSubmitting(true);
    try {
      const r = await licenseService.rebind({
        licenseKey: rebindKey.trim().toUpperCase(),
        email: rebindEmail.trim(),
      });
      if (!r.ok) {
        setRebindError(r.error || 'Rebind failed.');
        return;
      }
      setRebindSuccess(true);
      window.setTimeout(() => {
        setRebindOpen(false);
        setRebindSuccess(false);
        setRebindKey('');
        setRebindEmail('');
      }, 1500);
      await refreshLicense();
    } catch (err: any) {
      setRebindError(err?.message || 'Rebind request failed.');
    } finally {
      setRebindSubmitting(false);
    }
  };

  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(getMachineFingerprint());
      setFingerprintCopied(true);
      window.setTimeout(() => setFingerprintCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      await api.adminUpdateSettings(formData);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
      onRefresh();
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to update café settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters.');
      return;
    }

    setChangingPassword(true);
    setPasswordError(null);
    setPasswordSuccess(null);

    try {
      await api.adminChangePassword(currentPassword, newPassword);
      setPasswordSuccess('Password successfully updated!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPasswordSuccess(null), 3000);
    } catch (err: any) {
      setPasswordError(err?.message || 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleTestWhatsApp = () => {
    if (!formData.whatsappNumber) {
      alert('Please enter a destination WhatsApp phone number first.');
      return;
    }
    const cleanNumber = formData.whatsappNumber.replace(/[^0-9]/g, '');
    const testMsg = encodeURIComponent(
      `🔔 *TEST ORDER ALERT — ${formData.cafeName.toUpperCase()}*\n\n` +
      `Your WhatsApp notification integration is active and configured correctly.\n` +
      `Orders from QR table scans will be dispatched here.`
    );
    window.open(`https://wa.me/${cleanNumber}?text=${testMsg}`, '_blank');
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Settings Form */}
      <form onSubmit={handleSaveSettings} className="bg-white rounded-3xl p-6 border border-stone-200 shadow-xs space-y-6">
        <div className="flex items-center justify-between border-b border-stone-100 pb-4">
          <div>
            <h2 className="font-bold text-lg text-stone-900 flex items-center gap-2">
              <Building className="w-5 h-5 text-amber-700" />
              <span>Café Profile & Business Details</span>
            </h2>
            <p className="text-xs text-stone-500">
              Basic café branding and table ordering configurations.
            </p>
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="py-2.5 px-5 bg-amber-600 hover:bg-amber-700 disabled:bg-stone-300 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-sm transition-colors"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
          </button>
        </div>

        {saveSuccess && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Settings saved successfully!</span>
          </div>
        )}

        {saveError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500" />
            <span>{saveError}</span>
          </div>
        )}

        {/* Café Name & Tagline */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Business / Café Name *
            </label>
            <input
              type="text"
              required
              value={formData.cafeName}
              onChange={(e) => setFormData({ ...formData, cafeName: e.target.value })}
              className="w-full px-3.5 py-2 bg-stone-50 border border-stone-200 rounded-xl text-sm font-bold text-stone-900 focus:bg-white focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Tagline / Subtitle
            </label>
            <input
              type="text"
              value={formData.tagline}
              onChange={(e) => setFormData({ ...formData, tagline: e.target.value })}
              className="w-full px-3.5 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-medium text-stone-900 focus:bg-white focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* Contact Phone, Address & Currency */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Contact Phone
            </label>
            <input
              type="text"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              className="w-full px-3.5 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-semibold text-stone-900 focus:bg-white focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Currency Symbol
            </label>
            <input
              type="text"
              value={formData.currency}
              onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
              className="w-full px-3.5 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-bold text-stone-900 focus:bg-white focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              UPI ID for Payments
            </label>
            <input
              type="text"
              placeholder="e.g. nexoraosp@upi"
              value={formData.upiId || ''}
              onChange={(e) => setFormData({ ...formData, upiId: e.target.value })}
              className="w-full px-3.5 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-mono font-medium text-stone-900 focus:bg-white focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* WhatsApp Notification Integration Section */}
        <div className="pt-4 border-t border-stone-100 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-sm text-stone-900 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-600" />
                <span>WhatsApp Order Notification Integration</span>
              </h3>
              <p className="text-xs text-stone-500">
                Receive instant formatted order tickets with customer name, table number, and items.
              </p>
            </div>

            <button
              type="button"
              onClick={handleTestWhatsApp}
              className="py-1.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Test Alert via WhatsApp</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-stone-700 mb-1">
                WhatsApp Phone Number (with Country Code)
              </label>
              <input
                type="text"
                placeholder="+919876543210"
                value={formData.whatsappNumber}
                onChange={(e) => setFormData({ ...formData, whatsappNumber: e.target.value })}
                className="w-full px-3.5 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-bold text-stone-900 focus:bg-white focus:ring-2 focus:ring-amber-500"
              />
            </div>

            <div className="flex items-center gap-3 pt-6">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.enableWhatsAppAlerts}
                  onChange={(e) => setFormData({ ...formData, enableWhatsAppAlerts: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-stone-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                <span className="ml-3 text-xs font-bold text-stone-700">
                  Enable Order Alerts
                </span>
              </label>
            </div>
          </div>

          {/* Optional Webhook/Gateway API fields */}
          <div className="p-3.5 bg-stone-50 rounded-2xl border border-stone-200/80 space-y-3">
            <span className="text-[11px] font-bold text-stone-500 uppercase tracking-wider block">
              Optional Direct Webhook / Provider API (Twilio / GreenAPI / UltraMsg)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                  API Webhook URL
                </label>
                <input
                  type="url"
                  placeholder="https://api.green-api.com/waInstance.../sendMessage"
                  value={formData.whatsappApiUrl || ''}
                  onChange={(e) => setFormData({ ...formData, whatsappApiUrl: e.target.value })}
                  className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-stone-600 mb-1">
                  API Auth Token / Bearer Key
                </label>
                <input
                  type="password"
                  placeholder="Bearer token or instance key"
                  value={formData.whatsappApiToken || ''}
                  onChange={(e) => setFormData({ ...formData, whatsappApiToken: e.target.value })}
                  className="w-full px-3 py-1.5 bg-white border border-stone-200 rounded-lg text-xs font-mono text-stone-900"
                />
              </div>
            </div>
            <p className="text-[10px] text-stone-500">
              * Note: Even without an API gateway configured, you can click "WhatsApp" on any order card to instantly dispatch tickets to WhatsApp directly.
            </p>
          </div>
        </div>
      </form>

      {/* Admin Credentials & Security Card */}
      <form onSubmit={handleChangePassword} className="bg-white rounded-3xl p-6 border border-stone-200 shadow-xs space-y-4">
        <div className="border-b border-stone-100 pb-3">
          <h2 className="font-bold text-base text-stone-900 flex items-center gap-2">
            <Shield className="w-5 h-5 text-amber-700" />
            <span>Admin Authentication & Security</span>
          </h2>
          <p className="text-xs text-stone-500">
            Current logged in administrator: <strong className="text-stone-900">{adminEmail}</strong>
          </p>
        </div>

        {passwordSuccess && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>{passwordSuccess}</span>
          </div>
        )}

        {passwordError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500" />
            <span>{passwordError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Current Password
            </label>
            <input
              type="password"
              required
              placeholder="••••••••"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-medium text-stone-900"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              New Password
            </label>
            <input
              type="password"
              required
              placeholder="••••••••"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-medium text-stone-900"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-stone-700 mb-1">
              Confirm New Password
            </label>
            <input
              type="password"
              required
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs font-medium text-stone-900"
            />
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={changingPassword}
            className="py-2 px-4 bg-stone-900 hover:bg-stone-800 text-white font-bold text-xs rounded-xl shadow-xs transition-colors"
          >
            {changingPassword ? 'Updating Password...' : 'Update Password'}
          </button>
        </div>
      </form>

      {/* Desktop console — visible only inside the installed desktop app. */}
      {desktopInfo && (
        <div className="bg-white rounded-3xl p-6 border border-stone-200 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-stone-100 pb-4">
            <div>
              <h2 className="font-bold text-lg text-stone-900 flex items-center gap-2">
                <Monitor className="w-5 h-5 text-amber-700" />
                <span>Desktop Console</span>
              </h2>
              <p className="text-xs text-stone-500">
                This dashboard is running as an installed desktop app with a local order server.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-stone-600">
            <div className="bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
              <p className="font-bold text-stone-800">App version</p>
              <p className="font-mono">{desktopInfo.appVersion}</p>
            </div>
            <div className="bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
              <p className="font-bold text-stone-800">Platform</p>
              <p className="font-mono">{desktopInfo.platform} ({desktopInfo.arch})</p>
            </div>
            <div className="sm:col-span-2 bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
              <p className="font-bold text-stone-800">Local data folder</p>
              <p className="font-mono break-all">{desktopInfo.dataDir}</p>
            </div>
          </div>
          <button
            onClick={() => void window.nagoriDesktop?.openDataFolder()}
            className="py-2 px-4 bg-stone-900 hover:bg-stone-800 text-white font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            Open Data Folder
          </button>
        </div>
      )}

      {/* Subscription / License — only visible on distributed builds. */}
      {license?.licenseRequired && license.status.state !== 'not-required' && (
        <div className="bg-white rounded-3xl p-6 border border-stone-200 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-stone-100 pb-4">
            <div>
              <h2 className="font-bold text-lg text-stone-900 flex items-center gap-2">
                <Key className="w-5 h-5 text-amber-700" />
                <span>Subscription</span>
              </h2>
              <p className="text-xs text-stone-500">
                This copy of NEXORAOSP RESTAURANT is licensed to your café.
              </p>
            </div>
            <button
              type="button"
              onClick={handleHeartbeat}
              disabled={heartbeatRunning}
              className="py-1.5 px-3 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
              title="Re-check the subscription with the license server"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${heartbeatRunning ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {license.status.state === 'active' && license.status.payload && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-stone-600">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5">
                  <p className="font-bold text-emerald-800 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Subscription active
                  </p>
                  <p className="text-emerald-700 text-[11px] mt-0.5">
                    {license.status.payload.plan.charAt(0).toUpperCase() + license.status.payload.plan.slice(1)} plan
                  </p>
                </div>
                <div className="bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
                  <p className="font-bold text-stone-800">Registered café</p>
                  <p className="font-mono text-[11px] truncate">{license.status.payload.cafeName}</p>
                </div>
                <div className="bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
                  <p className="font-bold text-stone-800">Owner email</p>
                  <p className="font-mono text-[11px] truncate">{license.status.payload.email}</p>
                </div>
                <div className="bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
                  <p className="font-bold text-stone-800">
                    {license.status.payload.exp ? 'Renews / expires' : 'Plan type'}
                  </p>
                  <p className="font-mono text-[11px]">
                    {license.status.payload.exp
                      ? new Date(license.status.payload.exp).toLocaleDateString()
                      : 'Lifetime'}
                  </p>
                </div>
              </div>

              <div className="bg-stone-50 rounded-xl px-3 py-2 border border-stone-200">
                <p className="font-bold text-stone-800 text-xs flex items-center gap-1.5">
                  <span>This computer</span>
                  <button
                    onClick={copyFingerprint}
                    className="ml-auto p-1 hover:bg-stone-200 rounded transition-colors"
                    title="Copy fingerprint"
                  >
                    {fingerprintCopied ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    ) : (
                      <Copy className="w-3 h-3 text-stone-500" />
                    )}
                  </button>
                </p>
                <p className="font-mono text-[10px] break-all text-stone-600">{getMachineFingerprint()}</p>
                <p className="text-[10px] text-stone-500 mt-1">
                  Need to move the license to another computer?{' '}
                  <button
                    onClick={() => setRebindOpen(true)}
                    className="text-amber-700 hover:underline font-bold"
                  >
                    Transfer to a new computer
                  </button>
                </p>
                <p className="text-[10px] text-stone-500 mt-1">
                  Need to investigate who changed what?{' '}
                  <button
                    onClick={() => setAuditOpen(!auditOpen)}
                    className="text-amber-700 hover:underline font-bold"
                  >
                    {auditOpen ? 'Hide audit log' : 'View audit log'}
                  </button>
                </p>
                {auditOpen && (
                  <div className="mt-2 max-h-72 overflow-y-auto bg-stone-50 border border-stone-200 rounded-lg p-2 text-[10px] font-mono">
                    {auditEntries === null ? (
                      <p className="text-stone-500 px-2 py-1">Loading…</p>
                    ) : auditEntries.length === 0 ? (
                      <p className="text-stone-500 px-2 py-1">No audit entries yet.</p>
                    ) : (
                      auditEntries.map((entry, idx) => (
                        <div key={idx} className="px-2 py-1 border-b border-stone-200 last:border-b-0">
                          <span className="text-stone-400">{entry.ts}</span>{' '}
                          <span className="text-amber-700">{entry.method}</span>{' '}
                          <span className="text-stone-700">{entry.path}</span>
                          <div className="text-stone-500 truncate">
                            admin={entry.admin} · fp={entry.fingerprint}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {license.status.state === 'expired' && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
              <p className="text-amber-900 font-bold text-sm flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Your subscription has expired
              </p>
              <p className="text-amber-800 text-xs mt-1">{license.status.reason}</p>
              {license.status.gracePeriodEndsAt ? (
                <p className="text-amber-700 text-[11px] mt-1">
                  You can still use the app until {new Date(license.status.gracePeriodEndsAt).toLocaleString()}.
                  After that, admin access will be locked. Customer ordering keeps working.
                </p>
              ) : (
                <p className="text-amber-700 text-[11px] mt-1">
                  Admin access is locked. Customer ordering keeps working so the café doesn't go dark.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href="https://nexoraosp.com/renew"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="py-2 px-4 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-xl shadow-sm flex items-center gap-1.5"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Renew subscription
                </a>
                <button
                  onClick={handleHeartbeat}
                  className="py-2 px-4 bg-white border border-amber-300 text-amber-900 font-bold text-xs rounded-xl hover:bg-amber-50"
                >
                  Re-check now
                </button>
              </div>
            </div>
          )}

          {license.status.state === 'missing' && (
            <div className="p-3 bg-stone-50 border border-stone-200 rounded-xl">
              <p className="text-stone-800 font-bold text-sm">No license on this computer</p>
              <p className="text-stone-600 text-xs mt-1">
                If you have a license key from your purchase email, activate it to continue using the
                admin console. Customer ordering keeps working in the meantime.
              </p>
            </div>
          )}

          {license.status.state === 'invalid' && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
              <p className="text-red-800 font-bold text-sm">License file is invalid</p>
              <p className="text-red-700 text-xs mt-1">{license.status.reason}</p>
              <p className="text-red-600 text-[11px] mt-1">
                This usually means the license file was edited or copied from a different computer.
                Contact support if you need help restoring it.
              </p>
            </div>
          )}

          {/* Rebind modal */}
          {rebindOpen && (
            <div className="fixed inset-0 z-50 bg-stone-950/70 backdrop-blur-xs flex items-center justify-center p-4">
              <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-stone-200 overflow-hidden">
                <div className="p-4 bg-stone-900 text-white">
                  <h3 className="font-bold text-base">Transfer license to this computer</h3>
                  <p className="text-[11px] text-stone-400 mt-0.5">
                    The previous computer will be released automatically.
                  </p>
                </div>
                <form onSubmit={handleRebind} className="p-5 space-y-3">
                  {rebindError && (
                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs font-semibold flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{rebindError}</span>
                    </div>
                  )}
                  {rebindSuccess && (
                    <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs font-semibold flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      License transferred successfully. Reloading…
                    </div>
                  )}
                  <div>
                    <label className="block text-[11px] font-bold text-stone-700 mb-1 uppercase tracking-wider">
                      License key
                    </label>
                    <input
                      type="text"
                      value={rebindKey}
                      onChange={(e) => setRebindKey(e.target.value.toUpperCase())}
                      placeholder="NEX-XXXX-XXXX-XXXX"
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-stone-700 mb-1 uppercase tracking-wider">
                      Email used at purchase
                    </label>
                    <input
                      type="email"
                      value={rebindEmail}
                      onChange={(e) => setRebindEmail(e.target.value)}
                      placeholder="owner@yourcafe.com"
                      className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-bold"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setRebindOpen(false)}
                      className="flex-1 py-2 px-4 bg-stone-100 text-stone-700 text-xs font-bold rounded-xl"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={rebindSubmitting || rebindSuccess}
                      className="flex-1 py-2 px-4 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl disabled:bg-stone-300"
                    >
                      {rebindSubmitting ? 'Transferring…' : 'Transfer to this computer'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* App Updates — only meaningful on the desktop build. The web
          app always shows the latest deployed version, so the section
          is a no-op there (the button just does nothing). */}
      {desktopInfo && (
        <div className="bg-white rounded-3xl p-6 border border-stone-200 shadow-xs space-y-3">
          <div className="flex items-center justify-between border-b border-stone-100 pb-3">
            <div>
              <h2 className="font-bold text-lg text-stone-900 flex items-center gap-2">
                <Download className="w-5 h-5 text-sky-700" />
                <span>App updates</span>
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                You are running v{desktopInfo.appVersion}.
              </p>
            </div>
          </div>
          <p className="text-xs text-stone-600">
            The desktop app checks for updates on startup and every 4 hours.
            When a new version is published, a banner appears at the top of the
            dashboard with a one-click restart.
          </p>
          <button
            type="button"
            onClick={() => (window as unknown as { nagoriBridge?: { checkForUpdates?: () => Promise<void> } }).nagoriBridge?.checkForUpdates?.()}
            className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 transition flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Check for updates
          </button>
        </div>
      )}
    </div>
  );
};
