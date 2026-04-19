"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, Time, CandlestickSeries, MouseEventParams } from "lightweight-charts";
import type { CandleData } from "@/lib/api";

interface Level {
  price: number;
  label: string;
  color: string;
  description: string;
}

interface PriceChartProps {
  symbol: string;
  title: string;
  levels: Level[];
  interval?: string;
  currentPrice?: number;
}

interface OHLC {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function formatPrice(p: number): string {
  if (p < 1) return p.toFixed(4);
  if (p < 100) return p.toFixed(2);
  return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function PriceChart({ symbol, title, levels, interval = "1d", currentPrice }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredOHLC, setHoveredOHLC] = useState<OHLC | null>(null);
  const [latestOHLC, setLatestOHLC] = useState<OHLC | null>(null);
  const [lastFetchTime, setLastFetchTime] = useState<Date | null>(null);

  // Stable fetch function that doesn't depend on changing levels
  const fetchCandles = useCallback(async (series: ISeriesApi<"Candlestick">) => {
    try {
      const res = await fetch(`/api/candles?symbol=${symbol}&interval=${interval}&limit=200&t=${Date.now()}`);
      const candles: CandleData[] = await res.json();
      if (!Array.isArray(candles)) {
        setError("No data");
        return;
      }
      const chartData: CandlestickData<Time>[] = candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      series.setData(chartData);
      const last = candles[candles.length - 1];
      if (last) {
        setLatestOHLC({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
      }
      setLastFetchTime(new Date());
      setError(null);
      setLoading(false);
    } catch (e) {
      console.error("Candle fetch failed:", e);
      setError("Failed to load data");
      setLoading(false);
    }
  }, [symbol, interval]);

  // Initialize chart once per symbol/interval change
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0a" },
        textColor: "#d1d5db",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      width: containerRef.current.clientWidth,
      height: 400,
      timeScale: {
        borderColor: "#374151",
        timeVisible: true,
      },
      rightPriceScale: {
        borderColor: "#374151",
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "#6b7280", width: 1, style: 2 },
        horzLine: { color: "#6b7280", width: 1, style: 2 },
      },
    });

    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderDownColor: "#ef4444",
      borderUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      wickUpColor: "#22c55e",
    });

    seriesRef.current = candleSeries;

    // Add price level lines
    levels.forEach((level) => {
      candleSeries.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: level.label,
      });
    });

    // Crosshair handler — shows OHLC on hover
    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (!param.time || !param.seriesData.size) {
        setHoveredOHLC(null);
        return;
      }
      const data = param.seriesData.get(candleSeries);
      if (data && "open" in data) {
        const candle = data as CandlestickData<Time>;
        setHoveredOHLC({
          time: candle.time as number,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        });
      }
    });

    // Initial fetch + fit
    fetchCandles(candleSeries).then(() => {
      chart.timeScale().fitContent();
    });

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  // Auto-refresh candles every 15 min (independent of chart re-creation)
  useEffect(() => {
    const tick = setInterval(() => {
      if (seriesRef.current) {
        fetchCandles(seriesRef.current);
      }
    }, 900_000); // 15 min
    return () => clearInterval(tick);
  }, [fetchCandles]);

  // Display values: hovered candle if hovering, otherwise latest candle
  const displayed = hoveredOHLC || latestOHLC;
  const isUp = displayed && displayed.close >= displayed.open;
  const change = displayed ? ((displayed.close - displayed.open) / displayed.open) * 100 : 0;

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div>
          <h3 className="text-white font-semibold text-lg">{title}</h3>
          <span className="text-gray-400 text-xs">
            {symbol} · {interval}
            {lastFetchTime && (
              <span className="ml-2 text-gray-600">
                · candles: {lastFetchTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </span>
        </div>
        {currentPrice && (
          <div className="text-right">
            <div className="text-gray-500 text-[10px] uppercase tracking-wider">Live Price</div>
            <div className="text-white font-mono text-2xl font-semibold">
              {currentPrice < 1 ? `$${currentPrice.toFixed(4)}` : `$${currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
            </div>
          </div>
        )}
      </div>

      {/* OHLC Bar — shows hovered or latest candle */}
      {displayed && (
        <div className="px-4 py-2 bg-gray-900/60 border-b border-gray-800 flex items-center gap-4 text-xs font-mono">
          <span className="text-gray-500">
            {hoveredOHLC ? "Hover:" : "Latest candle:"}
          </span>
          <span className="text-gray-400">{formatDate(displayed.time)}</span>
          <span className="text-gray-500">O</span>
          <span className="text-white">${formatPrice(displayed.open)}</span>
          <span className="text-gray-500">H</span>
          <span className="text-green-400">${formatPrice(displayed.high)}</span>
          <span className="text-gray-500">L</span>
          <span className="text-red-400">${formatPrice(displayed.low)}</span>
          <span className="text-gray-500">C</span>
          <span className={isUp ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>
            ${formatPrice(displayed.close)}
          </span>
          <span className={`ml-auto ${isUp ? "text-green-500" : "text-red-500"}`}>
            {isUp ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
          </span>
        </div>
      )}

      {/* Chart */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#111] z-10">
            <div className="text-gray-400 animate-pulse">Loading chart...</div>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#111] z-10">
            <div className="text-red-400">{error}</div>
          </div>
        )}
        <div ref={containerRef} />
      </div>
    </div>
  );
}
