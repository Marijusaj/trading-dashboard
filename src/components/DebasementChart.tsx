"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, IChartApi, Time, LineData, LineSeries } from "lightweight-charts";
import type { CandleData } from "@/lib/api";

interface DebasementChartProps {
  goldPrice?: number;
}

export default function DebasementChart({ goldPrice }: DebasementChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentValue, setCurrentValue] = useState<number | null>(null);
  const [trend, setTrend] = useState<"debasing" | "strengthening">("debasing");

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
      height: 300,
      timeScale: { borderColor: "#374151", timeVisible: true },
      rightPriceScale: { borderColor: "#374151" },
    });

    chartRef.current = chart;

    // Main debasement line (1/Gold * 10000)
    const debasementSeries = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      title: "1/Gold (Debasement)",
    });

    // SMA overlay
    const smaSeries = chart.addSeries(LineSeries, {
      color: "#ef4444",
      lineWidth: 1,
      lineStyle: 2,
      title: "SMA(20)",
    });

    fetch("/api/gold?interval=1d&limit=365")
      .then((res) => res.json())
      .then((candles: CandleData[]) => {
        const MULTIPLIER = 10000;
        const debasementData: LineData<Time>[] = candles.map((c) => ({
          time: c.time as Time,
          value: MULTIPLIER / c.close,
        }));

        debasementSeries.setData(debasementData);

        // Calculate SMA
        const smaData: LineData<Time>[] = [];
        const period = 20;
        for (let i = period - 1; i < debasementData.length; i++) {
          let sum = 0;
          for (let j = 0; j < period; j++) {
            sum += debasementData[i - j].value;
          }
          smaData.push({
            time: debasementData[i].time,
            value: sum / period,
          });
        }
        smaSeries.setData(smaData);

        // Set current state
        if (debasementData.length > 1) {
          const last = debasementData[debasementData.length - 1].value;
          const prev = debasementData[debasementData.length - 2].value;
          setCurrentValue(last);
          setTrend(last < prev ? "debasing" : "strengthening");
        }

        chart.timeScale().fitContent();
        setLoading(false);
      })
      .catch(() => setLoading(false));

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
  }, []);

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div>
          <h3 className="text-white font-semibold text-lg">Dollar Debasement (1/Gold)</h3>
          <span className="text-gray-400 text-sm">
            Falling = dollar losing value · Rising = dollar strengthening
          </span>
        </div>
        <div className="text-right">
          {currentValue && (
            <div className={`font-mono text-lg ${trend === "debasing" ? "text-red-400" : "text-green-400"}`}>
              {currentValue.toFixed(4)}
              <span className="text-sm ml-2">
                {trend === "debasing" ? "▼ DEBASING" : "▲ STRENGTHENING"}
              </span>
            </div>
          )}
          {goldPrice && (
            <div className="text-yellow-500 text-sm font-mono">
              Gold: ${goldPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
          )}
        </div>
      </div>
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#111] z-10">
            <div className="text-gray-400 animate-pulse">Loading debasement data...</div>
          </div>
        )}
        <div ref={containerRef} />
      </div>
    </div>
  );
}
