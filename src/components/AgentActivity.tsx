"use client";

import { useEffect, useState } from "react";

interface Decision {
  id: string;
  ts: string;
  environment: "real" | "paper";
  decision_type: string;
  asset: string | null;
  reasoning: string;
  hvf_score: number | null;
  conviction: string | null;
  outcome_status: string;
  guardrail_violation: string | null;
}

interface OpenTrade {
  id: string;
  environment: string;
  asset: string;
  side: string;
  entry_price: number;
  size_usd: number;
  stop_loss: number;
  take_profit: number;
  leverage: number;
  opened_at: string;
  etoro_position_id: string;
}

interface ClosedTrade {
  id: string;
  environment: string;
  asset: string;
  side: string;
  entry_price: number;
  exit_price: number | null;
  size_usd: number;
  pnl_usd: number | null;
  r_multiple: number | null;
  exit_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}

interface MemoryRow {
  id: string;
  ts: string;
  category: string;
  asset: string | null;
  content: string;
  importance: number;
}

interface GuardrailState {
  environment: string;
  daily_realized_pnl: number;
  consecutive_losses: number;
  cooldown_until: string | null;
  last_entry_at: string | null;
  open_position_count: number;
}

interface AgentData {
  timestamp: string;
  decisions: Decision[];
  openTrades: OpenTrade[];
  recentClosed: ClosedTrade[];
  memory: MemoryRow[];
  guardrailState: GuardrailState[];
}

const STATUS_COLOR: Record<string, string> = {
  executed: "text-green-400",
  skipped_guardrail: "text-amber-400",
  failed: "text-red-400",
  pending: "text-gray-400",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n < 1 ? n.toFixed(4) : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtUsd(n: number | null | undefined, sign = false): string {
  if (n === null || n === undefined) return "—";
  const s = sign && n > 0 ? "+" : "";
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `${s}$${n.toFixed(2)}`;
}

export default function AgentActivity() {
  const [data, setData] = useState<AgentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/agent/activity", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (json.error) setError(json.error);
        else setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 900_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
        <div className="text-gray-500 text-sm animate-pulse">Loading agent activity...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-[#111] border border-red-900/50 rounded-lg p-4">
        <div className="text-red-400 text-sm">Agent activity unavailable: {error}</div>
        <div className="text-gray-500 text-xs mt-1">
          Likely missing DATABASE_URL (Neon) or migrations not run yet.
        </div>
      </div>
    );
  }

  const real = data.guardrailState.find((g) => g.environment === "real");
  const paper = data.guardrailState.find((g) => g.environment === "paper");

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white font-semibold">🤖 FrancisAgent</div>
            <div className="text-gray-500 text-xs">
              Autonomous HVF trader · Claude Opus 4.7 · runs every 4h
            </div>
          </div>
          <div className="text-gray-600 text-[10px]">
            {new Date(data.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* Guardrail state strip */}
      <div className="px-4 py-2 bg-gray-900/40 border-b border-gray-800 grid grid-cols-2 gap-3 text-[11px]">
        {[real, paper].filter(Boolean).map((g) => (
          <div key={g!.environment} className="flex items-center gap-2 font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${g!.environment === "real" ? "bg-orange-500" : "bg-blue-500"}`} />
            <span className="text-gray-400 uppercase tracking-wider text-[10px] w-12">{g!.environment}</span>
            <span className="text-gray-500">Open:</span>
            <span className="text-white">{g!.open_position_count}</span>
            <span className="text-gray-500 ml-2">Daily P&L:</span>
            <span className={Number(g!.daily_realized_pnl) >= 0 ? "text-green-400" : "text-red-400"}>
              {fmtUsd(Number(g!.daily_realized_pnl), true)}
            </span>
            {g!.cooldown_until && new Date(g!.cooldown_until) > new Date() && (
              <span className="text-amber-400 ml-auto">
                cooldown to {new Date(g!.cooldown_until).toLocaleTimeString()}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Open agent trades */}
      <div className="p-3">
        <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Open Agent Trades</div>
        {data.openTrades.length === 0 ? (
          <div className="text-gray-600 text-xs italic py-2">No open agent trades</div>
        ) : (
          <div className="space-y-1">
            {data.openTrades.map((t) => (
              <div key={t.id} className="grid grid-cols-12 gap-2 text-[11px] font-mono py-1 border-b border-gray-900/60 last:border-b-0">
                <span className={`col-span-1 text-[10px] uppercase ${t.environment === "real" ? "text-orange-400" : "text-blue-400"}`}>{t.environment}</span>
                <span className="col-span-2 text-white">{t.asset}</span>
                <span className={`col-span-1 ${t.side === "long" ? "text-green-400" : "text-red-400"}`}>{t.side.toUpperCase()}</span>
                <span className="col-span-2 text-gray-400 text-right">@{fmtPrice(t.entry_price)}</span>
                <span className="col-span-2 text-gray-400 text-right">SL {fmtPrice(t.stop_loss)}</span>
                <span className="col-span-2 text-gray-400 text-right">TP {fmtPrice(t.take_profit)}</span>
                <span className="col-span-2 text-gray-500 text-right">{fmtUsd(t.size_usd)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent decisions */}
      <div className="p-3 border-t border-gray-800">
        <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Recent Decisions</div>
        {data.decisions.length === 0 ? (
          <div className="text-gray-600 text-xs italic py-2">No decisions yet — first cron hasn&apos;t run</div>
        ) : (
          <div className="space-y-1">
            {data.decisions.slice(0, 8).map((d) => (
              <div key={d.id} className="text-[11px] py-1 border-b border-gray-900/60 last:border-b-0">
                <div className="flex items-center gap-2 font-mono">
                  <span className="text-gray-600 w-12">{timeAgo(d.ts)}</span>
                  <span className={`text-[10px] uppercase ${d.environment === "real" ? "text-orange-400" : "text-blue-400"}`}>{d.environment}</span>
                  <span className="text-gray-400 uppercase text-[10px]">{d.decision_type}</span>
                  {d.asset && <span className="text-amber-400 font-bold">{d.asset}</span>}
                  {d.hvf_score !== null && <span className="text-gray-500">HVF {Number(d.hvf_score).toFixed(0)}</span>}
                  <span className={`ml-auto text-[10px] ${STATUS_COLOR[d.outcome_status] || "text-gray-500"}`}>
                    {d.outcome_status}{d.guardrail_violation ? ` (${d.guardrail_violation})` : ""}
                  </span>
                </div>
                <div className="text-gray-500 text-[10px] pl-14 mt-0.5 line-clamp-2">{d.reasoning}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent closed (performance) */}
      {data.recentClosed.length > 0 && (
        <div className="p-3 border-t border-gray-800">
          <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Recent Closed Trades</div>
          <div className="space-y-1">
            {data.recentClosed.map((t) => (
              <div key={t.id} className="grid grid-cols-12 gap-2 text-[11px] font-mono py-1 border-b border-gray-900/60 last:border-b-0">
                <span className="col-span-1 text-gray-600">{t.closed_at ? timeAgo(t.closed_at) : "—"}</span>
                <span className={`col-span-1 text-[10px] uppercase ${t.environment === "real" ? "text-orange-400" : "text-blue-400"}`}>{t.environment}</span>
                <span className="col-span-2 text-white">{t.asset}</span>
                <span className={`col-span-1 ${t.side === "long" ? "text-green-400" : "text-red-400"}`}>{t.side.toUpperCase()}</span>
                <span className="col-span-2 text-gray-400 text-right">{fmtPrice(t.entry_price)}→{fmtPrice(t.exit_price)}</span>
                <span className={`col-span-2 text-right ${t.pnl_usd && t.pnl_usd >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {fmtUsd(t.pnl_usd, true)}
                </span>
                <span className="col-span-1 text-gray-500 text-right">{t.r_multiple ? `${t.r_multiple.toFixed(1)}R` : "—"}</span>
                <span className="col-span-2 text-gray-600 text-right text-[10px]">{t.exit_reason || ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Memory */}
      {data.memory.length > 0 && (
        <div className="p-3 border-t border-gray-800">
          <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Top Memory</div>
          <div className="space-y-1">
            {data.memory.map((m) => (
              <div key={m.id} className="text-[11px] flex items-start gap-2 py-1">
                <span className="text-gray-600 text-[10px] uppercase w-16 flex-shrink-0">{m.category}</span>
                {m.asset && <span className="text-amber-400 font-mono w-10 flex-shrink-0">{m.asset}</span>}
                <span className="text-gray-400 flex-1">{m.content}</span>
                <span className="text-gray-700 text-[10px] flex-shrink-0">★{m.importance}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
