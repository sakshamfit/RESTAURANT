import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  X,
  CheckCircle2,
  QrCode,
  Zap,
} from 'lucide-react';
import { CafeTable } from '../types';
import { playScanSuccessBeep } from '../utils/audioAlerts';

interface TableQRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTableDetected: (tableTokenOrNumber: string, tableName?: string) => void;
  availableTables: CafeTable[];
  currentTable: CafeTable | null;
}

export const TableQRScannerModal: React.FC<TableQRScannerModalProps> = ({
  isOpen,
  onClose,
  onTableDetected,
  availableTables,
  currentTable,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [hasCamera, setHasCamera] = useState<boolean>(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanSuccessMsg, setScanSuccessMsg] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState<string>('');

  // Extract table identifier from scanned text
  const parseScannedCode = (rawText: string): { identifier: string; name?: string } | null => {
    const text = rawText.trim();
    if (!text) return null;

    // 1. Check if it's a URL
    try {
      if (text.startsWith('http://') || text.startsWith('https://') || text.includes('?')) {
        const url = new URL(text, window.location.origin);
        const tableParam = url.searchParams.get('table') ||
          url.searchParams.get('t') ||
          url.searchParams.get('tableNumber') ||
          url.searchParams.get('tbl') ||
          url.searchParams.get('token') ||
          url.searchParams.get('tableToken');

        if (tableParam) {
          return { identifier: tableParam };
        }

        const pathMatch = url.pathname.match(/\/(order|table)\/([^/]+)/);
        if (pathMatch && pathMatch[2]) {
          return { identifier: pathMatch[2] };
        }
      }
    } catch {
      // Not a standard URL, continue with raw text parsing
    }

    // 2. Check if it's a token directly
    if (text.startsWith('nagori_tbl_tok_')) {
      return { identifier: text };
    }

    // 3. Check for "Table 1", "T1", "1"
    const numMatch = text.match(/(?:table|tbl|t)?\s*#?\s*(\d+)/i);
    if (numMatch && numMatch[1]) {
      return { identifier: numMatch[1], name: `Table ${numMatch[1]}` };
    }

    return { identifier: text };
  };

  const handleSuccessfulDetection = (detected: { identifier: string; name?: string }) => {
    playScanSuccessBeep();
    
    const matched = availableTables.find(
      (t) =>
        t.token === detected.identifier ||
        t.id === detected.identifier ||
        String(t.tableNumber) === detected.identifier ||
        t.name.toLowerCase() === detected.identifier.toLowerCase()
    );

    const displayName = matched ? matched.name : (detected.name || `Table ${detected.identifier}`);
    setScanSuccessMsg(`Auto-detected: ${displayName}`);

    setTimeout(() => {
      onTableDetected(matched ? matched.token : detected.identifier, displayName);
      onClose();
    }, 600);
  };

  // Start Camera Stream
  const startCamera = async () => {
    setCameraError(null);
    setScanSuccessMsg(null);
    setIsScanning(true);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setHasCamera(false);
      setCameraError('Camera access not supported on this browser. Please select table manually.');
      setIsScanning(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      if ('BarcodeDetector' in window) {
        const barcodeDetector = new (window as any).BarcodeDetector({
          formats: ['qr_code'],
        });

        const detectLoop = async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) {
            animFrameRef.current = requestAnimationFrame(detectLoop);
            return;
          }

          try {
            const barcodes = await barcodeDetector.detect(videoRef.current);
            if (barcodes && barcodes.length > 0) {
              const rawVal = barcodes[0].rawValue;
              const result = parseScannedCode(rawVal);
              if (result) {
                handleSuccessfulDetection(result);
                return;
              }
            }
          } catch {
            // Ignore frame detection errors
          }

          animFrameRef.current = requestAnimationFrame(detectLoop);
        };

        animFrameRef.current = requestAnimationFrame(detectLoop);
      }
    } catch (err: any) {
      console.warn('Camera stream error:', err);
      setHasCamera(false);
      setCameraError(
        err.name === 'NotAllowedError'
          ? 'Camera permission denied. Select your table below.'
          : 'Unable to start camera. Select your table below.'
      );
      setIsScanning(false);
    }
  };

  const stopCamera = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  };

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    const result = parseScannedCode(manualInput);
    if (result) {
      handleSuccessfulDetection(result);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 font-sans">
      <div className="bg-white border border-[#e7e2dc] w-full max-w-md rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh] text-[#1e130c]">
        
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#3a291e] flex items-center justify-between bg-[#1e130c] text-white">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#2a1b12] text-[#ea580c] border border-[#3d271a] flex items-center justify-center">
              <QrCode className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                Scan Table QR Code
              </h2>
              <p className="text-[11px] text-[#a89f91]">
                Point camera at the table QR sticker
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 text-[#a89f91] hover:text-white rounded-xl transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1 bg-[#faf8f5]">
          
          {/* Scanner Viewport */}
          <div className="relative w-full aspect-square max-h-60 sm:max-h-64 rounded-xl overflow-hidden bg-stone-950 border border-[#e7e2dc] flex items-center justify-center shadow-inner">
            {hasCamera && !cameraError ? (
              <>
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />

                {/* Animated QR Reticle Overlay */}
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div className="w-40 h-40 border-2 border-[#ea580c] rounded-xl relative shadow-sm">
                    {/* Corners */}
                    <div className="absolute -top-0.5 -left-0.5 w-3 h-3 border-t-2 border-l-2 border-[#ea580c]" />
                    <div className="absolute -top-0.5 -right-0.5 w-3 h-3 border-t-2 border-r-2 border-[#ea580c]" />
                    <div className="absolute -bottom-0.5 -left-0.5 w-3 h-3 border-b-2 border-l-2 border-[#ea580c]" />
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 border-b-2 border-r-2 border-[#ea580c]" />
                    {/* Scanning Line */}
                    <div className="w-full h-0.5 bg-[#ea580c] absolute top-1/2 -translate-y-1/2 animate-pulse shadow-md" />
                  </div>
                </div>

                <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none px-4">
                  <span className="text-[10px] font-bold bg-[#1e130c]/90 text-[#faf8f5] px-3 py-1 rounded-full border border-[#3a291e]">
                    Align Table QR code in frame
                  </span>
                </div>
              </>
            ) : (
              <div className="text-center p-4 space-y-2">
                <div className="w-10 h-10 rounded-xl bg-[#2a1b12] text-[#ea580c] flex items-center justify-center mx-auto">
                  <Camera className="w-5 h-5" />
                </div>
                <p className="text-xs text-[#a89f91] font-medium px-2">
                  {cameraError || 'Camera preview disabled'}
                </p>
                <button
                  type="button"
                  onClick={startCamera}
                  className="text-xs text-[#ea580c] hover:underline font-bold cursor-pointer"
                >
                  Retry Camera
                </button>
              </div>
            )}

            {/* Success Overlay Banner */}
            {scanSuccessMsg && (
              <div className="absolute inset-0 bg-stone-950/95 flex flex-col items-center justify-center gap-2 p-4">
                <div className="w-10 h-10 rounded-full bg-[#2a1b12] border border-[#3d271a] text-emerald-400 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <span className="text-sm font-bold text-white text-center">
                  {scanSuccessMsg}
                </span>
                <span className="text-[11px] text-[#ea580c] font-semibold">
                  Opening menu...
                </span>
              </div>
            )}
          </div>

          {/* Quick 1-Tap Table Selector Grid */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#1e130c] flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-[#ea580c]" />
                <span>Or Select Table Directly</span>
              </span>
              {currentTable && (
                <span className="text-[10px] text-[#6b5d52]">
                  Active: <strong className="text-[#ea580c]">{currentTable.name}</strong>
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              {availableTables.map((tbl) => {
                const isSelected = currentTable?.token === tbl.token;
                return (
                  <button
                    key={tbl.id}
                    type="button"
                    onClick={() => {
                      handleSuccessfulDetection({ identifier: tbl.token, name: tbl.name });
                    }}
                    className={`py-2 px-2 rounded-xl text-xs font-bold flex flex-col items-center justify-center gap-0.5 border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-[#ea580c] text-white border-[#ea580c] shadow-xs'
                        : 'bg-white hover:bg-[#f0ebe1] text-[#1e130c] border-[#e7e2dc]'
                    }`}
                  >
                    <span className="text-xs font-black">{tbl.name}</span>
                    <span className={`text-[9px] ${isSelected ? 'text-white/80' : 'text-[#6b5d52]'}`}>Select</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Manual Input Fallback */}
          <form onSubmit={handleManualSubmit} className="pt-2 border-t border-[#e7e2dc] space-y-2">
            <label className="block text-[11px] font-bold text-[#6b5d52]">
              Manual Table Number / Link
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="e.g. 1, 2, Table 3 or paste URL"
                className="flex-1 bg-white border border-[#e7e2dc] px-3 py-2 rounded-xl text-xs text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c]"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-[#1e130c] hover:bg-[#2a1b12] text-white font-bold text-xs rounded-xl transition-colors cursor-pointer shadow-xs"
              >
                Connect
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
