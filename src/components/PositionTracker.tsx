"use client";

import { POSITIONS, type Position } from "@/lib/positions";

interface PositionTrackerProps {
  trxPrice: number;
  btcPrice: number;
}

function PositionCard({ position, currentPrice }: { position: Position; currentPrice: number }) {
  const pnl = position.side === "long"
    ? (currentPrice - position.entryPrice) * position.amount
    : (position.entryPrice - currentPrice) * position.amount;
  const pnlPct = position.side === "long"
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const currentValue = currentPrice * position.amount;
  const stopDist = position.side === "long"
    ? ((currentPrice - position.stopLoss) / currentPrice) * 100
    : ((position.stopLoss - currentPrice) / currentPrice) * 100;

  const isProfit = pnl >= 0;

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${position.side === "long" ? "text-green-400" : "text-red-400"}`}>
            {position.side === "long" ? "🟢" : "🔴"}
          </span>
          <div>
            <span className="text-white font-semibold">{position.pair}</span>
            <span className="text-gray-500 text-xs ml-2">{position.side.toUpperCase()} · {position.exchange}</span>
          </div>
        </div>
        <span className="text-xs text-gray-600">{position.entryDate}</span>
      </div>

      {/* PnL Hero */}
      <div className={`text-center py-3 rounded-lg mb-3 ${isProfit ? "bg-green-950/40 border border-green-900/50" : "bg-red-950/40 border border-red-900/50"}`}>
        <div className={`text-2xl font-bold font-mono ${isProfit ? "text-green-400" : "text-red-400"}`}>
          {isProfit ? "+" : ""}{pnlPct.toFixed(2)}%
        </div>
        <div className={`text-sm font-mono ${isProfit ? "text-green-500" : "text-red-500"}`}>
          {isProfit ? "+" : ""}${pnl.toFixed(2)} USD
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-900/50 rounded p-2">
          <div className="text-gray-500">Entry</div>
          <div className="text-white font-mono">${position.entryPrice < 1 ? position.entryPrice.toFixed(4) : position.entryPrice.toLocaleString()}</div>
        </div>
        <div className="bg-gray-900/50 rounded p-2">
          <div className="text-gray-500">Now</div>
          <div className="text-white font-mono">${currentPrice < 1 ? currentPrice.toFixed(4) : currentPrice.toLocaleString()}</div>
        </div>
        <div className="bg-gray-900/50 rounded p-2">
          <div className="text-gray-500">Amount</div>
          <div className="text-white font-mono">{position.amount.toFixed(2)} {position.symbol}</div>
        </div>
        <div className="bg-gray-900/50 rounded p-2">
          <div className="text-gray-500">Value</div>
          <div className="text-white font-mono">${currentValue.toFixed(2)}</div>
        </div>
        <div className="bg-gray-900/50 rounded p-2">
          <div className="text-gray-500">Cost Basis</div>
          <div className="text-white font-mono">${position.costBasis.toFixed(2)}</div>
        </div>
        <div className={`rounded p-2 ${stopDist < 3 ? "bg-red-950/50 border border-red-900/30" : "bg-gray-900/50"}`}>
          <div className="text-gray-500">Stop Loss</div>
          <div className={`font-mono ${stopDist < 3 ? "text-red-400" : "text-white"}`}>
            ${position.stopLoss < 1 ? position.stopLoss.toFixed(4) : position.stopLoss.toLocaleString()}
            <span className="text-gray-600 ml-1">({stopDist.toFixed(1)}%)</span>
          </div>
        </div>
      </div>

      {/* Targets */}
      <div className="mt-3">
        <div className="text-gray-500 text-xs mb-1">Targets</div>
        <div className="space-y-1">
          {position.targets.map((target) => {
            const targetDist = position.side === "long"
              ? ((target.price - currentPrice) / currentPrice) * 100
              : ((currentPrice - target.price) / currentPrice) * 100;
            const hit = targetDist <= 0;
            const targetPnl = position.side === "long"
              ? (target.price - position.entryPrice) * position.amount
              : (position.entryPrice - target.price) * position.amount;

            return (
              <div key={target.price} className={`flex items-center justify-between text-xs rounded px-2 py-1 ${hit ? "bg-green-950/30 border border-green-800/30" : "bg-gray-900/30"}`}>
                <div className="flex items-center gap-1">
                  <span>{hit ? "✅" : "🎯"}</span>
                  <span className={hit ? "text-green-400" : "text-gray-400"}>{target.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 font-mono">${target.price < 1 ? target.price.toFixed(2) : target.price.toLocaleString()}</span>
                  <span className={`font-mono ${hit ? "text-green-400" : "text-gray-600"}`}>
                    {hit ? "HIT" : `▲${targetDist.toFixed(1)}%`}
                  </span>
                  <span className="text-gray-600 font-mono">+${targetPnl.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function PositionTracker({ trxPrice, btcPrice }: PositionTrackerProps) {
  const openPositions = POSITIONS.filter((p) => p.status === "open");

  if (openPositions.length === 0) return null;

  // Total PnL across all positions
  const totalPnl = openPositions.reduce((sum, pos) => {
    const price = pos.symbol === "TRX" ? trxPrice : btcPrice;
    const pnl = pos.side === "long"
      ? (price - pos.entryPrice) * pos.amount
      : (pos.entryPrice - price) * pos.amount;
    return sum + pnl;
  }, 0);

  const totalCost = openPositions.reduce((sum, pos) => sum + pos.costBasis, 0);
  const totalPnlPct = (totalPnl / totalCost) * 100;

  return (
    <div className="space-y-4">
      {/* Portfolio Summary */}
      <div className={`rounded-lg p-3 border ${totalPnl >= 0 ? "bg-green-950/20 border-green-900/40" : "bg-red-950/20 border-red-900/40"}`}>
        <div className="flex items-center justify-between">
          <span className="text-gray-400 text-sm">Portfolio PnL</span>
          <div className="text-right">
            <span className={`font-bold font-mono ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </span>
            <span className={`text-xs ml-2 font-mono ${totalPnlPct >= 0 ? "text-green-600" : "text-red-600"}`}>
              ({totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%)
            </span>
          </div>
        </div>
      </div>

      {/* Position Cards */}
      {openPositions.map((pos) => {
        const price = pos.symbol === "TRX" ? trxPrice : btcPrice;
        return <PositionCard key={`${pos.symbol}-${pos.side}`} position={pos} currentPrice={price} />;
      })}
    </div>
  );
}
