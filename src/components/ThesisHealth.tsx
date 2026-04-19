"use client";

import { useEffect, useState } from "react";
import { STATUS_CONFIG, type ClaimStatus } from "@/lib/thesis-claims";

interface Evaluation {
  id: string;
  category: "TRX" | "BTC" | "Macro";
  claim: string;
  source: string;
  status: ClaimStatus;
  reasoning: string;
}

interface ThesisHealthData {
  timestamp: string;
  marketData: {
    btc: number;
    trx: number;
    sol: number;
    btcDominance: number;
    usdtDominance: number;
  };
  overallStatus: "strong" | "holding" | "weakened" | "broken";
  counts: Partial<Record<ClaimStatus, number>>;
  evaluations: Evaluation[];
}

const OVERALL_CONFIG = {
  strong: { label: "STRONG", color: "text-green-300", bg: "bg-green-950/40 border-green-500/60" },
  holding: { label: "HOLDING", color: "text-green-400", bg: "bg-green-950/30 border-green-700/50" },
  weakened: { label: "WEAKENED", color: "text-amber-400", bg: "bg-amber-950/30 border-amber-700/50" },
  broken: { label: "BROKEN", color: "text-red-400", bg: "bg-red-950/30 border-red-700/50" },
};

export default function ThesisHealth() {
  const [data, setData] = useState<ThesisHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/thesis-health", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
        } else {
          setData(json);
        }
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
        <div className="text-gray-500 text-sm animate-pulse">Evaluating thesis health...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-[#111] border border-red-900/50 rounded-lg p-4">
        <div className="text-red-400 text-sm">Failed to evaluate thesis: {error}</div>
      </div>
    );
  }

  const overall = OVERALL_CONFIG[data.overallStatus];
  const groupedByCategory = data.evaluations.reduce((acc, e) => {
    if (!acc[e.category]) acc[e.category] = [];
    acc[e.category].push(e);
    return acc;
  }, {} as Record<string, Evaluation[]>);

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className={`px-4 py-3 border-b border-gray-800 ${overall.bg} border-2`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-white font-semibold">🩺 Thesis Health Check</span>
              <span className={`px-2 py-0.5 rounded text-xs font-bold font-mono ${overall.color} bg-black/30`}>
                {overall.label}
              </span>
            </div>
            <p className="text-gray-500 text-xs mt-0.5">
              Auto-evaluation of CryptoSniper claims · {new Date(data.timestamp).toLocaleString()}
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            {Object.entries(data.counts).map(([status, count]) => {
              const cfg = STATUS_CONFIG[status as ClaimStatus];
              return (
                <div key={status} className="text-center">
                  <div className={`font-bold ${cfg.color}`}>{count}</div>
                  <div className="text-gray-600 text-[10px]">{cfg.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Market snapshot */}
      <div className="px-4 py-2 bg-gray-900/40 border-b border-gray-800 grid grid-cols-5 gap-2 text-xs font-mono">
        <div>
          <div className="text-gray-500 text-[10px]">BTC</div>
          <div className="text-white">${data.marketData.btc.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">TRX</div>
          <div className="text-white">${data.marketData.trx.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">SOL</div>
          <div className="text-white">${data.marketData.sol.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">BTC.D</div>
          <div className="text-white">{data.marketData.btcDominance.toFixed(2)}%</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">USDT.D</div>
          <div className="text-white">{data.marketData.usdtDominance.toFixed(2)}%</div>
        </div>
      </div>

      {/* Evaluations grouped by category */}
      <div className="p-3 space-y-3">
        {(["TRX", "BTC", "Macro"] as const).map((category) => {
          const items = groupedByCategory[category] || [];
          if (items.length === 0) return null;
          return (
            <div key={category}>
              <div className="text-gray-500 text-xs font-medium mb-1.5 uppercase tracking-wider">
                {category}
              </div>
              <div className="space-y-1">
                {items.map((e) => {
                  const cfg = STATUS_CONFIG[e.status];
                  return (
                    <div
                      key={e.id}
                      className={`rounded px-3 py-2 border ${cfg.bg} text-xs`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-white">{e.claim}</div>
                          <div className="text-gray-500 text-[10px] italic mt-0.5">{e.source}</div>
                          <div className="text-gray-400 text-[11px] mt-1">{e.reasoning}</div>
                        </div>
                        <span className={`text-[10px] font-bold font-mono ${cfg.color} whitespace-nowrap`}>
                          {cfg.emoji} {cfg.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
