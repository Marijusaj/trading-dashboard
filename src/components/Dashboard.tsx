"use client";

import { useEffect, useState, useCallback } from "react";
import PriceChart from "./PriceChart";
import DebasementChart from "./DebasementChart";
import KeyLevelsPanel from "./KeyLevelsPanel";
import MetricsBar from "./MetricsBar";
import PositionTracker from "./PositionTracker";
import SignalPanel from "./SignalPanel";
import ThesisHealth from "./ThesisHealth";
import { BTC_LEVELS, TRX_LEVELS } from "@/lib/levels";
import { POSITIONS } from "@/lib/positions";

interface Prices {
  btc: number;
  trx: number;
  gold: number;
  btc24hChange: number;
  trx24hChange: number;
}

export default function Dashboard() {
  const [prices, setPrices] = useState<Prices>({
    btc: 71000,
    trx: 0.322,
    gold: 4746,
    btc24hChange: -2.9,
    trx24hChange: 0.98,
  });
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"btc" | "trx" | "pair">("btc");
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchPrices = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const res = await fetch("/api/prices");
      const data = await res.json();
      if (data && !data.error) {
        setPrices({
          btc: data.btc,
          trx: data.trx,
          gold: data.gold,
          btc24hChange: data.btc24hChange || 0,
          trx24hChange: data.trx24hChange || 0,
        });
      }
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (e) {
      console.error("Price fetch failed:", e);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    fetchPrices();
    setRefreshKey((k) => k + 1); // forces chart remount
  }, [fetchPrices]);

  useEffect(() => {
    fetchPrices();
    const interval = setInterval(fetchPrices, 900000); // every 15 min
    return () => clearInterval(interval);
  }, [fetchPrices]);

  // Browser notifications for key levels
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }

    const checkLevels = () => {
      const buffer = 0.02; // 2%
      BTC_LEVELS.forEach((level) => {
        const dist = Math.abs(prices.btc - level.price) / prices.btc;
        if (dist < buffer && Notification.permission === "granted") {
          new Notification(`BTC approaching ${level.label}`, {
            body: `BTC at $${prices.btc.toLocaleString()} — ${level.price.toLocaleString()} is ${(dist * 100).toFixed(1)}% away`,
            icon: "📉",
          });
        }
      });
    };

    checkLevels();
  }, [prices.btc]);

  return (
    <div className="min-h-screen bg-[#050505] p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">
            <span className="text-yellow-500">⚡</span> CryptoSniper Dashboard
          </h1>
          <p className="text-gray-500 text-sm">
            Francis Hunt Thesis Tracker · BTC Bearish / TRX Bullish / Dollar Debasement
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-xs text-gray-600">
            Last update: {lastUpdate || "loading..."}
          </div>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm transition-colors disabled:opacity-50"
          >
            {isRefreshing ? "⟳ Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Metrics Bar */}
      <div className="mb-6">
        <MetricsBar
          btcPrice={prices.btc}
          trxPrice={prices.trx}
          goldPrice={prices.gold}
          btc24hChange={prices.btc24hChange}
          trx24hChange={prices.trx24hChange}
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Charts Area (3 cols) */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          {/* Chart Tabs */}
          <div className="flex gap-2">
            {[
              { key: "btc" as const, label: "BTC/USD", color: "text-orange-400" },
              { key: "trx" as const, label: "TRX/USD", color: "text-green-400" },
              { key: "pair" as const, label: "TRX/BTC Pair", color: "text-purple-400" },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? "bg-gray-800 text-white border border-gray-700"
                    : "text-gray-500 hover:text-gray-300 hover:bg-gray-900"
                }`}
              >
                <span className={activeTab === tab.key ? tab.color : ""}>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Active Chart */}
          {activeTab === "btc" && (
            <PriceChart
              key={`btc-${refreshKey}`}
              symbol="BTCUSDT"
              title="Bitcoin / USD"
              levels={BTC_LEVELS}
              currentPrice={prices.btc}
            />
          )}
          {activeTab === "trx" && (
            <PriceChart
              key={`trx-${refreshKey}`}
              symbol="TRXUSDT"
              title="TRON / USD"
              levels={[
                ...TRX_LEVELS,
                ...POSITIONS.filter((p) => p.symbol === "TRX" && p.status === "open").map((p) => ({
                  price: p.entryPrice,
                  label: `Entry $${p.entryPrice.toFixed(4)}`,
                  color: "#3b82f6",
                  description: `Your entry — ${p.entryDate}`,
                })),
              ]}
              currentPrice={prices.trx}
            />
          )}
          {activeTab === "pair" && (
            <PriceChart
              key={`pair-${refreshKey}`}
              symbol="TRXBTC"
              title="TRON / BTC (Pair Trade)"
              levels={[
                { price: 0.00001697, label: "H&S Target (3.7x)", color: "#9c27b0", description: "Inverted H&S measured move target" },
                { price: 0.00000350, label: "H&S Neckline", color: "#ff9800", description: "Inverted H&S neckline — now support" },
              ]}
              currentPrice={prices.trx / prices.btc}
            />
          )}

          {/* Debasement Chart */}
          <DebasementChart key={`debase-${refreshKey}`} goldPrice={prices.gold} />

          {/* Thesis Health Check — auto-evaluates Francis's claims daily */}
          <ThesisHealth />

          {/* Trade Thesis Summary */}
          <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
            <h3 className="text-white font-semibold mb-3">📋 Trade Thesis — Independently Verified (April 2026)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="bg-gray-900/50 border border-gray-700/50 rounded-lg p-3">
                <div className="text-gray-300 font-semibold mb-1">📊 BTC — Bearish Under Pressure</div>
                <ul className="text-gray-400 space-y-1 text-xs">
                  <li>• <span className="text-amber-400">Bear flag being challenged</span> — broke $75K</li>
                  <li>• 200-week MA at $58K = historical floor (never broken)</li>
                  <li>• Whales accumulated 270K BTC in 30 days</li>
                  <li>• ETF inflows turned positive ($1.32B March)</li>
                  <li className="text-gray-600">• Francis targets $47K-$36K — $36K is extreme</li>
                </ul>
              </div>
              <div className="bg-green-950/30 border border-green-900/50 rounded-lg p-3">
                <div className="text-green-400 font-semibold mb-1">🟢 TRX — Consolidation at $0.33</div>
                <ul className="text-gray-400 space-y-1 text-xs">
                  <li>• W-bottom confirmed, breakout at <span className="text-green-400">$0.33</span></li>
                  <li>• Decorrelation from BTC <span className="text-green-400">verified</span> (CryptoQuant)</li>
                  <li>• USDT on Tron: <span className="text-amber-400">46%</span> (was 53%, declining)</li>
                  <li>• Target: $0.35 (supply zone), then $0.50</li>
                  <li className="text-gray-600">• Francis $4.72 target — no independent support</li>
                </ul>
              </div>
              <div className="bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-3">
                <div className="text-yellow-400 font-semibold mb-1">⚠️ Key Risks</div>
                <ul className="text-gray-400 space-y-1 text-xs">
                  <li>• BTC bear flag may be invalidated ($75K broken)</li>
                  <li>• If BTC rallies, TRX may not diverge as expected</li>
                  <li>• USDT market share on Tron declining</li>
                  <li>• Justin Sun regulatory risk unresolved</li>
                  <li>• Below $0.285 = thesis fully invalidated</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar (1 col) */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          <SignalPanel trxPrice={prices.trx} />
          <PositionTracker trxPrice={prices.trx} btcPrice={prices.btc} />
          <KeyLevelsPanel btcPrice={prices.btc} trxPrice={prices.trx} />
        </div>
      </div>

      {/* Footer */}
      <div className="mt-8 text-center text-gray-700 text-xs">
        Data from CoinGecko & Binance · Charts by Lightweight Charts · Not financial advice · Auto-refreshes every 15 min
      </div>
    </div>
  );
}
