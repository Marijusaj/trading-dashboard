"use client";

import { useEffect, useState } from "react";
import {
  TRX_SIGNAL,
  getSignalStatus,
  SIGNAL_CONFIG,
  type SignalStatus,
} from "@/lib/signals";

interface SignalPanelProps {
  trxPrice: number;
}

function PulsingDot({ status }: { status: SignalStatus }) {
  const config = SIGNAL_CONFIG[status];
  const isActive = status === "breakout" || status === "confirmed";

  return (
    <span className="relative flex h-4 w-4">
      {isActive && (
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${config.pulseColor} opacity-60 animate-ping`}
        />
      )}
      <span
        className={`relative inline-flex rounded-full h-4 w-4 ${config.pulseColor} ${
          status === "setup" ? "animate-pulse" : ""
        }`}
      />
    </span>
  );
}

function BreakoutMeter({ price, signal }: { price: number; signal: typeof TRX_SIGNAL }) {
  // Visual meter from invalidation to confirm level
  const range = signal.confirmLevel - signal.invalidateLevel;
  const position = Math.max(0, Math.min(1, (price - signal.invalidateLevel) / range));
  const breakoutPosition = (signal.breakoutLevel - signal.invalidateLevel) / range;

  return (
    <div className="mt-3">
      <div className="flex justify-between text-[10px] text-gray-600 mb-1">
        <span>${signal.invalidateLevel}</span>
        <span className="text-amber-500">${signal.breakoutLevel} breakout</span>
        <span className="text-green-500">${signal.confirmLevel} confirm</span>
      </div>
      <div className="relative h-3 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
        {/* Stop zone */}
        <div
          className="absolute left-0 top-0 h-full bg-red-950/60"
          style={{ width: `${((signal.stopLevel - signal.invalidateLevel) / range) * 100}%` }}
        />
        {/* Breakout line */}
        <div
          className="absolute top-0 h-full w-px bg-amber-500/80"
          style={{ left: `${breakoutPosition * 100}%` }}
        />
        {/* Confirm line */}
        <div className="absolute top-0 right-0 h-full w-px bg-green-500/80" />
        {/* Current price indicator */}
        <div
          className="absolute top-0 h-full w-1.5 rounded-full bg-white shadow-lg shadow-white/30 transition-all duration-500"
          style={{ left: `${Math.max(0, Math.min(98, position * 100))}%` }}
        />
      </div>
      {/* Distance labels */}
      <div className="flex justify-between mt-1 text-[10px]">
        <span className="text-red-500/70">
          Stop: {((price - signal.stopLevel) / price * 100).toFixed(1)}% away
        </span>
        {price < signal.breakoutLevel ? (
          <span className="text-amber-500/70">
            Breakout: {((signal.breakoutLevel - price) / price * 100).toFixed(1)}% to go
          </span>
        ) : price < signal.confirmLevel ? (
          <span className="text-green-500/70">
            Confirm: {((signal.confirmLevel - price) / price * 100).toFixed(1)}% to go
          </span>
        ) : (
          <span className="text-green-400">Confirmed!</span>
        )}
      </div>
    </div>
  );
}

function ScalingPlan({ price, signal }: { price: number; signal: typeof TRX_SIGNAL }) {
  const status = getSignalStatus(price, signal);
  const totalPlanned = signal.scalingPlan.reduce((s, t) => s + t.size, 0);
  const totalDeployed = signal.scalingPlan
    .filter((t) => t.status === "done")
    .reduce((s, t) => s + t.size, 0);

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-500 text-xs font-medium">Scaling Plan</span>
        <span className="text-gray-600 text-[10px]">
          ${totalDeployed.toLocaleString()} / ${totalPlanned.toLocaleString()} deployed
        </span>
      </div>
      <div className="space-y-1">
        {signal.scalingPlan.map((tranche) => {
          // Determine if this tranche is ready to fire
          const isReady =
            tranche.status !== "done" &&
            status !== "invalidated" &&
            tranche.triggerPrice !== null &&
            price >= tranche.triggerPrice;

          const isDone = tranche.status === "done";

          return (
            <div
              key={tranche.id}
              className={`flex items-center gap-2 text-xs rounded px-2 py-1.5 transition-all ${
                isDone
                  ? "bg-green-950/20 border border-green-900/30"
                  : isReady
                  ? "bg-amber-950/30 border border-amber-700/50 animate-pulse"
                  : "bg-gray-900/30 border border-gray-800/50"
              }`}
            >
              <span className="w-4 text-center">
                {isDone ? "✅" : isReady ? "🔔" : "⏳"}
              </span>
              <div className="flex-1 min-w-0">
                <div className={isDone ? "text-green-400" : isReady ? "text-amber-300" : "text-gray-500"}>
                  {tranche.label}
                </div>
                <div className="text-gray-600 text-[10px] truncate">{tranche.trigger}</div>
              </div>
              <span
                className={`font-mono text-xs ${
                  isDone ? "text-green-500" : isReady ? "text-amber-400 font-semibold" : "text-gray-600"
                }`}
              >
                ${tranche.size.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      {/* Risk/Reward at full deployment */}
      {status !== "invalidated" && (
        <div className="mt-2 bg-gray-900/30 rounded px-2 py-1.5 text-[10px]">
          <div className="text-gray-500 mb-1">If fully deployed ($4,110):</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span className="text-red-400">Risk at stop:</span>
            <span className="text-red-400 font-mono">~-$200 (5%)</span>
            <span className="text-green-400">$0.35 target:</span>
            <span className="text-green-400 font-mono">~+$530 (13%)</span>
            <span className="text-green-300">$0.50 target:</span>
            <span className="text-green-300 font-mono">~+$2,200 (55%)</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SignalPanel({ trxPrice }: SignalPanelProps) {
  const signal = TRX_SIGNAL;
  const [lastDailyClose, setLastDailyClose] = useState<number | undefined>(undefined);

  // Fetch last completed daily candle close to distinguish intraday vs confirmed breakout
  useEffect(() => {
    async function fetchDailyClose() {
      try {
        const res = await fetch("/api/candles?symbol=TRXUSDT&interval=1d&limit=2");
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 2) {
          // The second-to-last candle is the last COMPLETED daily candle
          setLastDailyClose(data[data.length - 2].close);
        } else if (Array.isArray(data) && data.length === 1) {
          setLastDailyClose(data[0].close);
        }
      } catch {
        // If fetch fails, we'll use price-only logic (shows "testing" instead of "breakout")
      }
    }
    fetchDailyClose();
    const interval = setInterval(fetchDailyClose, 900_000); // refresh every 15 min
    return () => clearInterval(interval);
  }, []);

  const status = getSignalStatus(trxPrice, signal, lastDailyClose);
  const config = SIGNAL_CONFIG[status];

  return (
    <div className={`rounded-lg p-4 border-2 ${config.bgColor} ${config.borderColor} transition-all`}>
      {/* Signal Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <PulsingDot status={status} />
          <div>
            <span className={`text-lg font-bold font-mono tracking-wider ${config.color}`}>
              {config.label}
            </span>
            <span className="text-gray-600 text-xs ml-2">{signal.asset}</span>
          </div>
        </div>
        <span className="text-[10px] text-gray-600">{signal.lastUpdated}</span>
      </div>

      {/* Status Description */}
      <p className="text-gray-400 text-xs mb-1">{config.description}</p>
      <p className="text-gray-600 text-[10px] italic">Source: {signal.source}</p>

      {/* Breakout Meter */}
      <BreakoutMeter price={trxPrice} signal={signal} />

      {/* Targets Quick View */}
      <div className="mt-3 flex gap-1">
        {signal.targets.map((t) => {
          const hit = trxPrice >= t.price;
          return (
            <div
              key={t.price}
              className={`flex-1 text-center rounded py-1 text-[10px] ${
                hit ? "bg-green-950/40 text-green-400" : "bg-gray-900/40 text-gray-500"
              }`}
            >
              <div className="font-mono">${t.price < 1 ? t.price.toFixed(2) : t.price}</div>
              <div className="text-[9px]">{t.label}</div>
            </div>
          );
        })}
      </div>

      {/* Scaling Plan */}
      <ScalingPlan price={trxPrice} signal={signal} />

      {/* Daily Close Status */}
      <div className="mt-3 bg-gray-900/40 rounded px-2 py-1.5 text-[10px]">
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Last daily close:</span>
          {lastDailyClose !== undefined ? (
            <span className={`font-mono font-semibold ${lastDailyClose >= signal.breakoutLevel ? "text-green-400" : "text-amber-400"}`}>
              ${lastDailyClose.toFixed(4)}
              {lastDailyClose >= signal.breakoutLevel ? " ABOVE $0.33" : " below $0.33"}
            </span>
          ) : (
            <span className="text-gray-600">loading...</span>
          )}
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-gray-500">Current (intraday):</span>
          <span className={`font-mono ${trxPrice >= signal.breakoutLevel ? "text-green-400" : "text-gray-400"}`}>
            ${trxPrice.toFixed(4)}
          </span>
        </div>
      </div>

      {/* Francis Notes */}
      <div className="mt-3 border-t border-gray-800 pt-2">
        <div className="text-gray-600 text-[10px]">
          <span className="text-gray-500 font-medium">Sniper Notes: </span>
          {signal.notes}
        </div>
      </div>
    </div>
  );
}
