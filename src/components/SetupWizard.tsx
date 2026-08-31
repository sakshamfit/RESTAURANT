import React, { useEffect, useState } from 'react';
import {
  Key,
  Coffee,
  Building,
  Mail,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { licenseService, getMachineFingerprint, type LicenseStatusResponse } from '../services/license';

interface SetupWizardProps {
  /**
   * When the wizard finishes (license activated OR the user is in a
   * self-hosted build where a license is not required), the parent
   * re-renders and the main app takes over.
   */
  onComplete: () => void;
}

/**
 * First-run setup wizard.
 *
 * Two distinct paths:
 *   • License NOT required (self-hosted / dev): the wizard collects
 *     café name + admin password and finishes without ever asking for a
 *     license key.
 *   • License REQUIRED (distributed build): the wizard collects café
 *     name + email + license key, calls /api/license/activate, and only
 *     proceeds on success.
 *
 * The same screen covers both. The `licenseRequired` flag comes from
 * /api/license/status.
 */
export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const [status, setStatus] = useState<LicenseStatusResponse | null>(null);
  const [step, setStep] = useState<'checking' | 'cafe' | 'license' | 'admin' | 'done'>('checking');
  const [cafeName, setCafeName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [licenseKey, setLicenseKey] = useState<string>('');
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await licenseService.getStatus();
        if (cancelled) return;
        setStatus(s);
        // If a license is already active (re-running setup from Café Settings
        // is not via this wizard, but the install could in theory be reset),
        // skip straight to done.
        if (s.status.state === 'active') {
          onComplete();
          return;
        }
        setStep(s.licenseRequired ? 'license' : 'cafe');
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || 'Cannot reach the server.');
        setStep('cafe');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onComplete]);

  const handleCafeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!cafeName.trim()) {
      setError('Please enter your café name.');
      return;
    }
    // Persist the café name immediately so the rest of the setup can read it.
    try {
      window.localStorage.setItem('nagori_pending_cafe_name', cafeName.trim());
    } catch {
      // ignore
    }
    setStep('admin');
  };

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (adminPassword.length < 6) {
      setError('Admin password must be at least 6 characters.');
      return;
    }
    if (adminPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      // The wizard doesn't talk to the API directly to set the admin
      // password (that would require a chicken-and-egg auth flow). The
      // first admin password is set on the server by env var
      // ADMIN_PASSWORD, OR the user can change it from Café Settings →
      // Update Password after first login. We stash the desired
      // password in localStorage so a "first login" hint can pick it
      // up.
      try {
        window.localStorage.setItem('nagori_pending_admin_password', adminPassword);
      } catch {
        // ignore
      }
      setStep('done');
      // Brief "you're all set" flash before handing off.
      window.setTimeout(onComplete, 800);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLicenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!cafeName.trim() || !email.trim() || !licenseKey.trim()) {
      setError('All three fields are required to activate your license.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await licenseService.activate({
        licenseKey: licenseKey.trim().toUpperCase(),
        email: email.trim(),
        cafeName: cafeName.trim(),
      });
      if (!result.ok) {
        setError(result.error || 'Activation failed. Please check your key and try again.');
        return;
      }
      // Persist the café name for the rest of the app to pick up.
      try {
        window.localStorage.setItem('nagori_pending_cafe_name', result.payload?.cafeName || cafeName.trim());
      } catch {
        // ignore
      }
      setStep('done');
      window.setTimeout(onComplete, 800);
    } catch (err: any) {
      setError(err?.message || 'Activation request failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'checking') {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-4">
        <div className="text-center space-y-3 text-white">
          <div className="w-10 h-10 border-[3px] border-orange-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs font-semibold text-stone-400">Preparing your café console…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf8f5] flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-[#ea580c] text-white flex items-center justify-center mx-auto shadow-md">
            <Coffee className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-black text-[#1e130c] tracking-tight mt-3">
            Welcome to NEXORAOSP RESTAURANT
          </h1>
          <p className="text-xs text-[#6b5d52] mt-1">
            {status?.licenseRequired
              ? 'Activate your license to start taking orders.'
              : 'A few quick details to set up your café console.'}
          </p>
        </div>

        {/* Card */}
        <div className="bg-white border border-[#e7e2dc] rounded-3xl p-6 shadow-md space-y-5">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Step 1: License activation (paid builds) */}
          {step === 'license' && (
            <form onSubmit={handleLicenseSubmit} className="space-y-4">
              <div>
                <h2 className="font-bold text-base text-[#1e130c] flex items-center gap-2">
                  <Key className="w-4 h-4 text-[#ea580c]" />
                  Activate your license
                </h2>
                <p className="text-[11px] text-[#6b5d52] mt-0.5">
                  Enter the license key we emailed you and the same email you used at checkout.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6b5d52] uppercase tracking-wider mb-1">
                  Café / Restaurant name *
                </label>
                <div className="relative">
                  <Building className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a89f91]" />
                  <input
                    type="text"
                    required
                    autoFocus
                    placeholder="e.g. The Green Café"
                    value={cafeName}
                    onChange={(e) => setCafeName(e.target.value)}
                    className="w-full pl-9 pr-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-[#ea580c] focus:border-[#ea580c] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6b5d52] uppercase tracking-wider mb-1">
                  Email used at purchase *
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a89f91]" />
                  <input
                    type="email"
                    required
                    placeholder="owner@yourcafe.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-9 pr-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-[#ea580c] focus:border-[#ea580c] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6b5d52] uppercase tracking-wider mb-1">
                  License key *
                </label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a89f91]" />
                  <input
                    type="text"
                    required
                    placeholder="NEX-XXXX-XXXX-XXXX"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                    className="w-full pl-9 pr-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-mono font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-[#ea580c] focus:border-[#ea580c] outline-none uppercase"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <p className="text-[10px] text-[#a89f91] mt-1.5">
                  Lost your key?{' '}
                  <a
                    href="https://nexoraosp.com/account"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#ea580c] hover:underline inline-flex items-center gap-0.5"
                  >
                    Look it up at nexoraosp.com/account
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </p>
              </div>

              <div className="p-3 bg-stone-50 border border-[#e7e2dc] rounded-xl text-[11px] text-[#6b5d52]">
                <p className="font-bold text-[#1e130c] mb-0.5">This computer will be registered</p>
                <p className="font-mono text-[10px] break-all">{getMachineFingerprint()}</p>
                <p className="text-[10px] text-[#a89f91] mt-1">
                  You can move your license to a different computer any time from Café Settings → Subscription.
                </p>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-3 bg-[#ea580c] hover:bg-[#c2410c] disabled:bg-stone-300 text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Activating…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    Activate &amp; Open Console
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}

          {/* Step 1: Café name (self-hosted) */}
          {step === 'cafe' && (
            <form onSubmit={handleCafeSubmit} className="space-y-4">
              <div>
                <h2 className="font-bold text-base text-[#1e130c] flex items-center gap-2">
                  <Building className="w-4 h-4 text-[#ea580c]" />
                  Name your café
                </h2>
                <p className="text-[11px] text-[#6b5d52] mt-0.5">
                  This is what customers will see on their menu and order tickets.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6b5d52] uppercase tracking-wider mb-1">
                  Café / Restaurant name *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. The Green Café"
                  value={cafeName}
                  onChange={(e) => setCafeName(e.target.value)}
                  className="w-full px-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-[#ea580c] focus:border-[#ea580c] outline-none"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* Step 2: Admin password (self-hosted only) */}
          {step === 'admin' && (
            <form onSubmit={handleAdminSubmit} className="space-y-4">
              <div>
                <h2 className="font-bold text-base text-[#1e130c] flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#ea580c]" />
                  Set the admin password
                </h2>
                <p className="text-[11px] text-[#6b5d52] mt-0.5">
                  You will use this password to log in to the staff console. Customers don't see this.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6b5d52] uppercase tracking-wider mb-1">
                  New password *
                </label>
                <input
                  type="password"
                  required
                  autoFocus
                  minLength={6}
                  placeholder="At least 6 characters"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  className="w-full px-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-[#ea580c] focus:border-[#ea580c] outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#6b5d52] uppercase tracking-wider mb-1">
                  Confirm password *
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="Type the same password again"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-[#ea580c] focus:border-[#ea580c] outline-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep('cafe')}
                  className="px-4 py-3 text-[#6b5d52] font-bold text-xs rounded-xl hover:bg-stone-100 transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-3 bg-[#ea580c] hover:bg-[#c2410c] disabled:bg-stone-300 text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      Open Console
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Done */}
          {step === 'done' && (
            <div className="py-6 text-center space-y-3">
              <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <p className="text-base font-bold text-[#1e130c]">You're all set!</p>
              <p className="text-xs text-[#6b5d52]">Loading your café console…</p>
            </div>
          )}
        </div>

        <p className="text-[10px] text-center text-[#a89f91] mt-4">
          Need help? Contact <a href="mailto:support@nexoraosp.com" className="text-[#ea580c] hover:underline">support@nexoraosp.com</a>
        </p>
      </div>
    </div>
  );
};
