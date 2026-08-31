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
  Sparkles,
  Gift,
} from 'lucide-react';
import { licenseService, getMachineFingerprint, type LicenseStatusResponse } from '../services/license';

interface SetupWizardProps {
  /**
   * When the wizard finishes (license activated, trial started, or the
   * user is in a self-hosted build where a license is not required),
   * the parent re-renders and the main app takes over.
   */
  onComplete: () => void;
}

type Step = 'checking' | 'choose' | 'cafe' | 'license' | 'admin' | 'done';

/**
 * First-run setup wizard.
 *
 * Three paths, all sharing the same shell:
 *   1. License NOT required (self-hosted / dev): the wizard collects
 *      café name + admin password and finishes without ever asking for a
 *      license key.
 *   2. License REQUIRED with trial available (default distributed build):
 *      user picks "Start free trial" or "I have a license key", then
 *      café name (+ email + key, or just café name for trial).
 *   3. License REQUIRED, no trial: forces license activation.
 */
export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const [status, setStatus] = useState<LicenseStatusResponse | null>(null);
  const [step, setStep] = useState<Step>('checking');
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
        // Already activated? Skip the wizard.
        if (s.status.state === 'active') {
          onComplete();
          return;
        }
        if (s.licenseRequired) {
          setStep('choose');
        } else {
          setStep('cafe');
        }
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
      try {
        window.localStorage.setItem('nagori_pending_admin_password', adminPassword);
      } catch {
        // ignore
      }
      setStep('done');
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

  const handleTrialStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!cafeName.trim()) {
      setError('Please enter your café name first.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await licenseService.startTrial();
      if (!result.ok) {
        setError('Could not start the trial. Please try again.');
        return;
      }
      try {
        window.localStorage.setItem('nagori_pending_cafe_name', cafeName.trim());
      } catch {
        // ignore
      }
      setStep('done');
      window.setTimeout(onComplete, 800);
    } catch (err: any) {
      setError(err?.message || 'Could not start the trial.');
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
              ? 'Pick how you\'d like to start — you can change this any time.'
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

          {/* Step 0: choose trial vs license (distributed builds with a trial) */}
          {step === 'choose' && (
            <div className="space-y-4">
              <div>
                <h2 className="font-bold text-base text-[#1e130c] flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#ea580c]" />
                  How would you like to start?
                </h2>
                <p className="text-[11px] text-[#6b5d52] mt-0.5">
                  Both options unlock the full admin console immediately.
                </p>
              </div>

              {status?.trialAvailable && (
                <button
                  type="button"
                  onClick={() => setStep('admin')}
                  className="w-full text-left p-4 rounded-2xl border-2 border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                      <Gift className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-sm text-[#1e130c]">
                        Start a {status.trialDays}-day free trial
                      </p>
                      <p className="text-[11px] text-[#6b5d52] mt-0.5">
                        Use every feature now. No credit card. Subscribe before the
                        trial ends to keep the admin console.
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-emerald-700 mt-2 shrink-0" />
                  </div>
                </button>
              )}

              <button
                type="button"
                onClick={() => setStep('cafe')}
                className="w-full text-left p-4 rounded-2xl border-2 border-[#e7e2dc] hover:border-[#ea580c] hover:bg-orange-50/40 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#1e130c] text-[#ea580c] flex items-center justify-center shrink-0">
                    <Key className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-sm text-[#1e130c]">I have a license key</p>
                    <p className="text-[11px] text-[#6b5d52] mt-0.5">
                      Enter the key we emailed you after purchase. You'll be billed
                      through your normal subscription cycle.
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#6b5d52] mt-2 shrink-0" />
                </div>
              </button>

              <p className="text-[10px] text-center text-[#a89f91]">
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
          )}

          {/* Trial start: collect café name, then mint trial */}
          {step === 'admin' && status?.licenseRequired && status?.trialAvailable && (
            <form onSubmit={handleTrialStart} className="space-y-4">
              <div>
                <h2 className="font-bold text-base text-[#1e130c] flex items-center gap-2">
                  <Gift className="w-4 h-4 text-emerald-600" />
                  Start your {status.trialDays}-day free trial
                </h2>
                <p className="text-[11px] text-[#6b5d52] mt-0.5">
                  Full access for {status.trialDays} days. Subscribe any time before
                  the trial ends to keep your data and settings.
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
                    className="w-full pl-9 pr-3 py-2.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep('choose')}
                  className="px-4 py-3 text-[#6b5d52] font-bold text-xs rounded-xl hover:bg-stone-100 transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-300 text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Starting trial…
                    </>
                  ) : (
                    <>
                      Start Trial
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Step 1: License activation (distributed build, user has a key) */}
          {step === 'cafe' && status?.licenseRequired && (
            <form onSubmit={(e) => { e.preventDefault(); if (!cafeName.trim()) { setError('Please enter your café name.'); return; } setStep('license'); }} className="space-y-4">
              <div>
                <h2 className="font-bold text-base text-[#1e130c] flex items-center gap-2">
                  <Building className="w-4 h-4 text-[#ea580c]" />
                  Café name + license key
                </h2>
                <p className="text-[11px] text-[#6b5d52] mt-0.5">
                  Enter the name of your café, then your license key and the email
                  you used at purchase.
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

              <div className="flex items-center gap-2">
                {status.trialAvailable && (
                  <button
                    type="button"
                    onClick={() => setStep('choose')}
                    className="px-4 py-3 text-[#6b5d52] font-bold text-xs rounded-xl hover:bg-stone-100 transition-colors"
                  >
                    Back
                  </button>
                )}
                <button
                  type="submit"
                  className="flex-1 py-3 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors"
                >
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}

          {step === 'license' && status?.licenseRequired && (
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
                  Email used at purchase *
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a89f91]" />
                  <input
                    type="email"
                    required
                    autoFocus
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
              </div>

              <div className="p-3 bg-stone-50 border border-[#e7e2dc] rounded-xl text-[11px] text-[#6b5d52]">
                <p className="font-bold text-[#1e130c] mb-0.5">Café</p>
                <p className="font-mono text-[10px]">{cafeName}</p>
                <p className="font-bold text-[#1e130c] mb-0.5 mt-2">This computer will be registered</p>
                <p className="font-mono text-[10px] break-all">{getMachineFingerprint()}</p>
                <p className="text-[10px] text-[#a89f91] mt-1">
                  You can move your license to a different computer any time from Café Settings → Subscription.
                </p>
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
                      Activating…
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      Activate
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Step 1 (self-hosted): just café name */}
          {step === 'cafe' && !status?.licenseRequired && (
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
          {step === 'admin' && !status?.licenseRequired && (
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
