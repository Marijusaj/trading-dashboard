"use client";

import { useEffect, useState } from "react";

interface EnrichedPosition {
  positionID: string;
  instrumentID: number;
  isBuy: boolean;
  units: number;
  openRate: number;
  amountInDollars?: number;
  leverage?: number;
  stopLossRate?: number;
  takeProfitRate?: number;
  openDateTime: string;
  symbol: string | null;
  currentPrice: number | null;
  unrealizedPnL: number | null;
  unrealizedPnLPct: number | null;
}

interface EnvSnapshot {
  env: "real" | "paper";
  ok: boolean;
  error: string | null;
  credit: number | null;
  positions: EnrichedPosition[];
  totalUnrealizedPnL: number | null;
  totalEquity: number | null;
}

interface PortfolioData {
  timestamp: string;
  accounts: {
    paper: EnvSnapshot;
    real: EnvSnapshot;
  };
}

function formatUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  const formatted =
    abs < 0.01
      ? n.toFixed(4)
      : abs < 100
        ? n.toFixed(2)
        : n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (opts.sign && n > 0) return `+$${formatted}`;
  if (n < 0) return `-$${formatted.replace(/^-/, "")}`;
  return `$${formatted}`;
}

function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function PositionRow({ p }: { p: EnrichedPosition }) {
  const sideColor = p.isBuy ? "text-green-400" : "text-red-400";
  const pnlColor =
    p.unrealizedPnL === null
      ? "text-gray-500"
      : p.unrealizedPnL >= 0
        ? "text-green-400"
        : "text-red-400";
  return (
    <div className="grid grid-cols-12 gap-2 text-[11px] font-mono py-1.5 border-b border-gray-900/60 last:border-b-0">
      <div className="col-span-2 truncate text-white">
        {p.symbol || `#${p.instrumentID}`}
      </div>
      <div className={`col-span-1 ${sideColor} font-semibold`}>
        {p.isBuy ? "LONG" : "SHORT"}
      </div>
      <div className="col-span-2 text-gray-400 text-right">
        {p.openRate < 1 ? p.openRate.toFixed(4) : p.openRate.toLocaleString("en-US", { maximumFractionDigits: 2 })}
      </div>
      <div className="col-span-2 text-white text-right">
        {p.currentPrice === null ? "—" : (p.currentPrice < 1 ? p.currentPrice.toFixed(4) : p.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 }))}
      </div>
      <div className="col-span-2 text-gray-400 text-right">
        {formatUsd(p.amountInDollars)}
      </div>
      <div className={`col-span-3 text-right ${pnlColor}`}>
        {formatUsd(p.unrealizedPnL, { sign: true })}{" "}
        <span className="text-[10px]">({formatPct(p.unrealizedPnLPct)})</span>
      </div>
    </div>
  );
}

function AccountCard({ snapshot, label, accent }: { snapshot: EnvSnapshot; label: string; accent: string }) {
  if (!snapshot.ok) {
    return (
      <div className="bg-[#0f0f0f] border border-red-900/50 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full ${accent}`} />
          <span className="text-white font-semibold text-sm">{label}</span>
          <span className="text-red-400 text-[10px] ml-auto">CONNECTION FAILED</span>
        </div>
        <div className="text-red-400 text-[11px]">{snapshot.error}</div>
        <div className="text-gray-600 text-[10px] mt-1">
          Check ETORO_PUBLIC_KEY and ETORO_{snapshot.env.toUpperCase()}_API_KEY in Vercel env vars.
        </div>
      </div>
    );
  }

  const totalPnL = snapshot.totalUnrealizedPnL;
  const pnlColor =
    totalPnL === null ? "text-gray-500" : totalPnL >= 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="bg-[#0f0f0f] border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${accent}`} />
        <span className="text-white font-semibold text-sm">{label}</span>
        <span className="text-gray-600 text-[10px] ml-auto">
          {snapshot.positions.length} open
        </span>
      </div>

      {/* Equity row */}
      <div className="px-3 py-2 grid grid-cols-3 gap-2 text-[11px] font-mono bg-gray-900/30 border-b border-gray-800">
        <div>
          <div className="text-gray-500 text-[10px]">Cash</div>
          <div className="text-white">{formatUsd(snapshot.credit)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">Unrealized P&L</div>
          <div className={pnlColor}>{formatUsd(totalPnL, { sign: true })}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">Equity</div>
          <div className="text-white">{formatUsd(snapshot.totalEquity)}</div>
        </div>
      </div>

      {/* Positions */}
      <div className="px-3 py-2">
        {snapshot.positions.length === 0 ? (
          <div className="text-gray-600 text-[11px] italic py-3 text-center">No open positions</div>
        ) : (
          <>
            <div className="grid grid-cols-12 gap-2 text-[10px] text-gray-600 uppercase tracking-wider pb-1 border-b border-gray-900">
              <div className="col-span-2">Sym</div>
              <div className="col-span-1">Side</div>
              <div className="col-span-2 text-right">Entry</div>
              <div className="col-span-2 text-right">Current</div>
              <div className="col-span-2 text-right">Size</div>
              <div className="col-span-3 text-right">Unrealized</div>
            </div>
            {snapshot.positions.map((p) => (
              <PositionRow key={p.positionID} p={p} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export default function EtoroPositions() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/etoro/portfolio", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (json.error) setError(json.error);
        else setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 900_000); // 15 min
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
        <div className="text-gray-500 text-sm animate-pulse">Loading eToro positions...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-[#111] border border-red-900/50 rounded-lg p-4">
        <div className="text-red-400 text-sm">eToro: {error}</div>
        <div className="text-gray-500 text-xs mt-1">
          Add env vars in Vercel: ETORO_PUBLIC_KEY, ETORO_REAL_API_KEY, ETORO_PAPER_API_KEY
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white font-semibold">📊 eToro Portfolio</div>
            <div className="text-gray-500 text-xs">
              Real (live capital) + Paper (agent learning sandbox) ·
              <span className="text-gray-600 ml-1">{new Date(data.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <AccountCard snapshot={data.accounts.real} label="Real Account" accent="bg-orange-500" />
        <AccountCard snapshot={data.accounts.paper} label="Paper Account" accent="bg-blue-500" />
      </div>
    </div>
  );
}
