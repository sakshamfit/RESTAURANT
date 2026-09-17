import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { X, Download, Printer, ExternalLink, Coffee, ArrowLeft, Wifi, Copy, CheckCircle2, AlertTriangle, Settings2 } from 'lucide-react';
import { CafeTable, CafeSettings } from '../types';
import type { NagoriDesktopInfo } from '../desktop';
import { fetchNetworkInfo, pickBestQrBaseUrl, buildOrderUrl, isLoopbackOrigin, type NetworkInfo } from '../utils/qrBaseUrl';

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
  const [qrBaseSource, setQrBaseSource] = useState<string>('');
  const [isLoopback, setIsLoopback] = useState<boolean>(false);
  const [lanWarning, setLanWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [desktopInfo, setDesktopInfo] = useState<NagoriDesktopInfo | null>(null);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [loadingNetwork, setLoadingNetwork] = useState<boolean>(true);
  const printAreaRef = useRef<HTMLDivElement>(null);

  // Fetch desktop info and network info in parallel
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadingNetwork(true);
      const promises: Promise<any>[] = [];

      if (window.nagoriDesktop?.isDesktop) {
        promises.push(
          window.nagoriDesktop
            .getInfo()
            .then((info) => {
              if (!cancelled) setDesktopInfo(info);
            })
            .catch(() => {
              if (!cancelled) setDesktopInfo(null);
            })
        );
      }

      promises.push(
        fetchNetworkInfo()
          .then((info) => {
            if (!cancelled) setNetworkInfo(info);
          })
          .catch(() => {
            if (!cancelled) setNetworkInfo(null);
          })
      );

      await Promise.all(promises);
      if (!cancelled) setLoadingNetwork(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve best base URL for QR
  useEffect(() => {
    const settingsQrBase = (settings as any).qrBaseUrl || (settings as any).publicBaseUrl || '';
    const desktopLanUrl = desktopInfo?.lanUrls?.[0]?.url || null;
    const desktopLocalUrl = desktopInfo?.localUrl || null;

    const picked = pickBestQrBaseUrl({
      settingsQrBaseUrl: settingsQrBase,
      desktopLanUrl: desktopLanUrl || undefined,
      desktopLocalUrl: desktopLocalUrl || undefined,
      networkInfo,
      windowOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
    });

    const fullUrl = buildOrderUrl(picked.baseUrl, table.token);
    setQrSourceUrl(fullUrl);
    setQrBaseSource(picked.source);
    setIsLoopback(picked.isLoopback);

    // Warnings
    if (picked.isLoopback) {
      if (networkInfo?.lanUrls && networkInfo.lanUrls.length > 0) {
        // We have LAN but still using loopback — shouldn't happen, but warn
        setLanWarning(
          `QR is using loopback (${picked.baseUrl}) but LAN addresses are available: ${networkInfo.lanUrls.map((u) => u.url).join(', ')}. If customer phones can't open the menu, set a custom QR Base URL in Admin → Settings.`
        );
      } else if (desktopInfo && (!desktopInfo.lanUrls || desktopInfo.lanUrls.length === 0)) {
        setLanWarning(
          'No Wi-Fi / Ethernet address detected on this computer. Connect the staff computer to the café Wi-Fi, then reopen this dialog. Otherwise the printed QR codes will show 127.0.0.1 and will NOT open on customer phones (Safari: "could not connect to server").'
        );
      } else if (!desktopInfo && !networkInfo?.lanUrls?.length) {
        // Web build, no LAN detected from server (maybe running in container without host network)
        setLanWarning(
          `No LAN address detected from server. The QR currently points at ${picked.baseUrl} which will NOT work on phones (127.0.0.1 is this computer only). Fix: run server with HOST=0.0.0.0 and set APP_URL=http://<your-lan-ip>:${networkInfo?.port || window.location.port || 3000} OR set a custom QR Base URL in Admin → Settings.`
        );
      } else {
        setLanWarning(
          `QR is using ${picked.baseUrl} — this is a loopback address that customer phones CANNOT open. Make sure the server is bound to 0.0.0.0 and you are on the same Wi-Fi. If needed, set APP_URL or a custom QR Base URL in settings to your LAN IP (e.g. http://192.168.1.42:${networkInfo?.port || 3000}).`
        );
      }
    } else {
      setLanWarning(null);
    }

    // Generate QR
    QRCode.toDataURL(fullUrl, {
      width: 400,
      margin: 1,
      color: {
        dark: '#1e130c',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    })
      .then((dataUrl) => setQrDataUrl(dataUrl))
      .catch((err) => console.error('Failed to generate QR code:', err));
  }, [table, desktopInfo, networkInfo, settings]);

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

  const allLanUrls = [
    ...(desktopInfo?.lanUrls || []),
    ...(networkInfo?.lanUrls || []),
  ].filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i);

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
                  {loadingNetwork ? 'Detecting network...' : 'Generating QR...'}
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

          {/* Network info + warnings */}
          <div className="w-full max-w-xs mt-4 space-y-2">
            <div className="flex items-start gap-2 p-2.5 bg-white border border-[#e7e2dc] rounded-xl text-left">
              <Wifi className="w-4 h-4 text-[#ea580c] mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-[#1e130c] flex items-center gap-1">
                  QR points at
                  {isLoopback && <span className="px-1 py-0.5 bg-red-100 text-red-700 rounded text-[9px] font-bold">LOOPBACK — WON'T WORK ON PHONES</span>}
                </p>
                <p className="text-[10px] font-mono text-[#6b5d52] break-all">{qrSourceUrl || 'Detecting...'}</p>
                <p className="text-[9px] text-[#a89f91] mt-1">Source: {qrBaseSource} {loadingNetwork ? '(loading...)' : ''}</p>
                <p className="text-[10px] text-[#6b5d52] mt-1">
                  Customer phones must be on the <strong>same Wi-Fi</strong> as this computer.
                </p>
                {allLanUrls.length > 1 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] font-bold text-[#1e130c]">Other LAN URLs on this machine:</p>
                    {allLanUrls.map((u) => (
                      <p key={u.url} className="text-[9px] font-mono text-[#6b5d52] break-all">• {u.url} ({u.interface})</p>
                    ))}
                  </div>
                )}
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
              <div className={`p-2.5 border rounded-xl text-[11px] flex gap-2 ${isLoopback ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{lanWarning}</span>
              </div>
            )}

            {isLoopback && (
              <div className="p-2.5 bg-stone-900 border border-stone-800 rounded-xl text-[11px] text-stone-300">
                <p className="font-bold text-amber-400 flex items-center gap-1"><Settings2 className="w-3 h-3" /> How to fix "Safari could not connect to server"</p>
                <ol className="list-decimal ml-4 mt-1 space-y-1 text-[10px]">
                  <li>Make sure server runs with <code className="bg-stone-800 px-1 rounded">HOST=0.0.0.0</code> (already set in new build).</li>
                  <li>Find your computer's LAN IP: on Mac <code className="bg-stone-800 px-1 rounded">ifconfig | grep 192.168</code>, on Windows <code className="bg-stone-800 px-1 rounded">ipconfig</code>.</li>
                  <li>Set env <code className="bg-stone-800 px-1 rounded">APP_URL=http://YOUR_LAN_IP:PORT</code> then restart server, OR go to Admin → Settings and set <strong>QR Base URL</strong> to <code className="bg-stone-800 px-1 rounded">http://YOUR_LAN_IP:PORT</code>.</li>
                  <li>Re-open this QR dialog — it should now show your LAN IP, not 127.0.0.1.</li>
                  <li>Both staff computer and customer phone must be on same Wi-Fi.</li>
                </ol>
              </div>
            )}

            {settings.qrBaseUrl && (
              <div className="p-2 bg-emerald-50 border border-emerald-200 rounded-xl text-[11px] text-emerald-800">
                Custom QR Base URL active: <code className="font-mono font-bold">{settings.qrBaseUrl}</code> (from Admin Settings). QR codes use this.
              </div>
            )}
          </div>
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
