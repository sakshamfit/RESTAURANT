import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { X, Download, Printer, ExternalLink, Coffee, ArrowLeft, Wifi, Copy, CheckCircle2 } from 'lucide-react';
import { CafeTable, CafeSettings } from '../types';
import type { NagoriDesktopInfo } from '../desktop';

interface QRPrintModalProps {
  table: CafeTable;
  allTables?: CafeTable[];
  settings: CafeSettings;
  onClose: () => void;
}

export const QRPrintModal: React.FC<QRPrintModalProps> = ({
  table,
  allTables = [],
  settings,
  onClose,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [qrSourceUrl, setQrSourceUrl] = useState<string>('');
  const [lanWarning, setLanWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [desktopInfo, setDesktopInfo] = useState<NagoriDesktopInfo | null>(null);
  const printAreaRef = useRef<HTMLDivElement>(null);

  // Fetch the desktop info once. The URL the QR encodes is derived from the
  // staff machine's LAN address, not from the staff window's loopback URL —
  // a customer's phone on the café Wi-Fi has no route to 127.0.0.1.
  useEffect(() => {
    if (!window.nagoriDesktop?.isDesktop) return;
    window.nagoriDesktop
      .getInfo()
      .then((info) => setDesktopInfo(info))
      .catch(() => setDesktopInfo(null));
  }, []);

  /**
   * The URL the printed QR code points at. Inside the desktop app this MUST
   * be the staff machine's LAN address (e.g. `http://192.168.1.42:38245/…`),
   * not the browser's `window.location.origin` — that one is the staff
   * window's loopback URL (`http://127.0.0.1:…`) and a customer's phone on
   * the same Wi-Fi has no route to it, producing
   * "Safari could not connect to the server".
   */
  const resolveTableUrl = (token: string, info: NagoriDesktopInfo | null): string => {
    if (info) {
      const lan = info.lanUrls?.[0]?.url;
      if (lan) return `${lan}/order/${token}`;
      // No LAN IP detected — staff machine is offline. Fall back to the
      // loopback and tell the user clearly so they don't print a QR that
      // nobody can open.
      return `${info.localUrl || window.location.origin}/order/${token}`;
    }
    return `${window.location.origin}/order/${token}`;
  };

  useEffect(() => {
    const url = resolveTableUrl(table.token, desktopInfo);
    setQrSourceUrl(url);
    if (desktopInfo) {
      const lan = desktopInfo.lanUrls;
      if (!lan || lan.length === 0) {
        setLanWarning(
          'No Wi-Fi / Ethernet address detected on this computer. Connect the staff computer to the café Wi-Fi, then reopen this dialog. Otherwise the printed QR codes will not open on customer phones.'
        );
      } else {
        setLanWarning(null);
      }
    } else {
      setLanWarning(null);
    }
    QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      color: {
        dark: '#1e130c',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => setQrDataUrl(dataUrl))
      .catch((err) => console.error('Failed to generate QR code:', err));
  }, [table, desktopInfo]);

  const handleDownloadSingle = () => {
    const link = document.createElement('a');
    link.download = `NEXORAOSP_RESTAURANT_QR_Table_${table.tableNumber}.png`;
    link.href = qrDataUrl;
    link.click();
  };

  const handlePrint = () => {
    window.print();
  };

  const handleCopyLink = async () => {
    if (!qrSourceUrl) return;
    try {
      await navigator.clipboard.writeText(qrSourceUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / non-secure contexts — best-effort fallback.
      const input = document.createElement('input');
      input.value = qrSourceUrl;
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // ignore
      } finally {
        document.body.removeChild(input);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-4 font-sans">
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-[#e7e2dc]">
        {/* Header */}
        <div className="p-4 sm:p-5 bg-[#1e130c] text-white flex items-center justify-between border-b border-[#3a291e]">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1.5 bg-[#2a1b12] hover:bg-[#3d271a] text-[#ea580c] hover:text-white rounded-xl flex items-center gap-1 text-xs font-semibold transition-colors cursor-pointer mr-1"
              title="Go Back"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Back</span>
            </button>
            <div>
              <h2 className="font-bold text-sm sm:text-base leading-tight">
                Table QR Standee
              </h2>
              <p className="text-xs text-[#a89f91]">
                {table.name} • Table #{table.tableNumber}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-[#a89f91] hover:text-white rounded-xl transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Standee Preview Card */}
        <div className="p-6 bg-[#faf8f5] flex flex-col items-center">
          <div
            ref={printAreaRef}
            id="printable-qr-standee"
            className="w-full max-w-xs bg-white rounded-2xl p-6 border border-[#e7e2dc] shadow-sm text-center space-y-4 print:border-none print:shadow-none print:p-0"
          >
            {/* Café Header */}
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 rounded-2xl bg-[#ea580c] text-white flex items-center justify-center shadow-md mb-2">
                <Coffee className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-[#1e130c] leading-tight">
                {settings.cafeName}
              </h3>
              <p className="text-[10px] font-semibold text-[#6b5d52] uppercase tracking-widest">
                {settings.tagline || 'Scan & Order at Table'}
              </p>
            </div>

            {/* Table Number Pill */}
            <div className="inline-block px-4 py-1.5 bg-[#1e130c] text-[#ea580c] rounded-full font-black text-xs tracking-wide shadow-xs">
              {table.name.toUpperCase()}
            </div>

            {/* QR Code Container */}
            <div className="p-3 bg-white rounded-xl border border-[#e7e2dc] inline-block shadow-xs">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`QR for ${table.name}`}
                  className="w-44 h-44 mx-auto"
                />
              ) : (
                <div className="w-44 h-44 flex items-center justify-center text-xs text-[#6b5d52]">
                  Generating QR...
                </div>
              )}
            </div>

            {/* Instructions */}
            <div className="space-y-1">
              <p className="text-xs font-bold text-[#1e130c]">
                1. Point Camera at QR Code
              </p>
              <p className="text-[11px] text-[#6b5d52]">
                2. View Menu & Order Directly
              </p>
              <p className="text-[10px] font-semibold text-[#ea580c] mt-1">
                Freshly prepared and served to this table
              </p>
            </div>
          </div>

          {/* Desktop-only: show which URL the QR encodes and warn if no LAN IP. */}
          {desktopInfo && (
            <div className="w-full max-w-xs mt-4 space-y-2">
              <div className="flex items-start gap-2 p-2.5 bg-white border border-[#e7e2dc] rounded-xl text-left">
                <Wifi className="w-4 h-4 text-[#ea580c] mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold text-[#1e130c]">QR points at</p>
                  <p className="text-[10px] font-mono text-[#6b5d52] break-all">{qrSourceUrl}</p>
                  <p className="text-[10px] text-[#6b5d52] mt-1">
                    Customer phones must be on the <strong>same Wi-Fi</strong> as this computer to open the menu.
                  </p>
                </div>
                <button
                  onClick={handleCopyLink}
                  className="shrink-0 p-1.5 rounded-lg bg-[#faf8f5] hover:bg-[#f0ebe1] border border-[#e7e2dc] text-[#1e130c] transition-colors cursor-pointer"
                  title="Copy link"
                >
                  {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              {lanWarning && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-[11px] text-red-800">
                  ⚠ {lanWarning}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Actions */}
        <div className="p-4 sm:p-5 bg-white border-t border-[#e7e2dc] space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleDownloadSingle}
              className="py-2.5 px-4 bg-[#faf8f5] hover:bg-[#f0ebe1] border border-[#e7e2dc] text-[#1e130c] font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download PNG</span>
            </button>

            <button
              onClick={handlePrint}
              className="py-2.5 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-md transition-colors cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print Standee</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="w-full py-2.5 px-4 bg-[#faf8f5] hover:bg-[#f0ebe1] text-[#6b5d52] font-semibold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-colors cursor-pointer border border-[#e7e2dc]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Close</span>
          </button>

          {/* Test Link — desktop: open the customer view on this computer; web: open in a new tab. */}
          <div className="pt-1 text-center">
            <a
              href={qrSourceUrl || `${window.location.origin}/order/${table.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-[#ea580c] hover:underline inline-flex items-center gap-1"
            >
              <span>Preview Customer Link for {table.name}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
