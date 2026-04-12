"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, Time, CandlestickSeries } from "lightweight-charts";
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

export default function PriceChart({ symbol, title, levels, interval = "1d", currentPrice }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

    // Add horizontal price lines for Francis's levels
    levels.forEach((level) => {
      candleSeries.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 2,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: level.label,
      });
    });

    // Fetch and set data via API route (avoids CORS)
    fetch(`/api/candles?symbol=${symbol}&interval=${interval}&limit=200`)
      .then((res) => res.json())
      .then((candles: CandleData[]) => {
        const chartData: CandlestickData<Time>[] = candles.map((c: CandleData) => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        candleSeries.setData(chartData);
        chart.timeScale().fitContent();
        setLoading(false);
      })
      .catch((err) => {
        setError("Failed to load data");
        setLoading(false);
        console.error(err);
      });

    // Resize handler
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
  }, [symbol, interval, levels]);

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div>
          <h3 className="text-white font-semibold text-lg">{title}</h3>
          <span className="text-gray-400 text-sm">{symbol} · {interval}</span>
        </div>
        {currentPrice && (
          <div className="text-right">
            <div className="text-white font-mono text-xl">
              {currentPrice < 1 ? currentPrice.toFixed(6) : currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </div>
          </div>
        )}
      </div>
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#111] z-10">
            <div className="text-gray-400 animate-pulse">Loading chart...</div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#111] z-10">
            <div className="text-red-400">{error}</div>
          </div>
        )}
        <div ref={containerRef} />
      </div>
    </div>
  );
}
