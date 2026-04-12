"use client";

import { BTC_LEVELS, TRX_LEVELS } from "@/lib/levels";

interface KeyLevelsPanelProps {
  btcPrice: number;
  trxPrice: number;
}

function LevelRow({
  level,
  currentPrice,
}: {
  level: { price: number; label: string; color: string; description: string };
  currentPrice: number;
}) {
  const distance = ((currentPrice - level.price) / currentPrice) * 100;
  const isBelow = currentPrice < level.price;
  const formatPrice = (p: number) =>
    p < 1 ? `$${p.toFixed(4)}` : `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <div className="flex items-center justify-between py-2 px-3 hover:bg-gray-800/50 rounded transition-colors">
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: level.color }} />
        <div>
          <div className="text-sm text-white font-medium">{level.label}</div>
          <div className="text-xs text-gray-500">{level.description}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-mono text-white">{formatPrice(level.price)}</div>
        <div className={`text-xs font-mono ${isBelow ? "text-green-400" : distance < 10 ? "text-yellow-400" : "text-gray-400"}`}>
          {distance > 0 ? `${distance.toFixed(1)}% above` : `${Math.abs(distance).toFixed(1)}% below`}
        </div>
      </div>
    </div>
  );
}

export default function KeyLevelsPanel({ btcPrice, trxPrice }: KeyLevelsPanelProps) {
  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800">
        <h3 className="text-white font-semibold">CryptoSniper Key Levels</h3>
        <span className="text-gray-400 text-xs">Francis Hunt — March 2026 Analysis</span>
      </div>

      {/* BTC Levels */}
      <div className="px-2 py-2">
        <div className="flex items-center gap-2 px-3 py-1">
          <span className="text-orange-400 font-semibold text-sm">BTC/USD</span>
          <span className="text-gray-500 text-xs">Downside Targets</span>
          <span className="ml-auto text-white font-mono text-sm">${btcPrice.toLocaleString()}</span>
        </div>
        {BTC_LEVELS.map((level) => (
          <LevelRow key={level.price} level={level} currentPrice={btcPrice} />
        ))}
      </div>

      <div className="border-t border-gray-800" />

      {/* TRX Levels */}
      <div className="px-2 py-2">
        <div className="flex items-center gap-2 px-3 py-1">
          <span className="text-green-400 font-semibold text-sm">TRX/USD</span>
          <span className="text-gray-500 text-xs">Upside Targets</span>
          <span className="ml-auto text-white font-mono text-sm">${trxPrice.toFixed(4)}</span>
        </div>
        {TRX_LEVELS.map((level) => (
          <LevelRow key={level.price} level={level} currentPrice={trxPrice} />
        ))}
      </div>

      <div className="border-t border-gray-800" />

      {/* Pair Trade Summary */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-purple-400 font-semibold text-sm">TRX/BTC Pair Trade</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500">Current Ratio</div>
            <div className="text-white font-mono">{(trxPrice / btcPrice).toFixed(8)}</div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500">Target (3.7x)</div>
            <div className="text-purple-400 font-mono">0.00001697</div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500">BTC Mcap</div>
            <div className="text-white font-mono">${(btcPrice * 19.8).toFixed(0)}B</div>
          </div>
          <div className="bg-gray-900 rounded p-2">
            <div className="text-gray-500">TRX Mcap</div>
            <div className="text-white font-mono">${(trxPrice * 95.4).toFixed(1)}B</div>
          </div>
        </div>
      </div>
    </div>
  );
}
