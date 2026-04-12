"use client";

interface MetricsBarProps {
  btcPrice: number;
  trxPrice: number;
  goldPrice: number;
  btc24hChange: number;
  trx24hChange: number;
}

function Metric({ label, value, change, prefix = "$" }: { label: string; value: string; change?: number; prefix?: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-2">
      <div className="text-gray-500 text-xs uppercase tracking-wide">{label}</div>
      <div className="text-white font-mono text-lg font-semibold">
        {prefix}{value}
      </div>
      {change !== undefined && (
        <div className={`text-xs font-mono ${change >= 0 ? "text-green-400" : "text-red-400"}`}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
        </div>
      )}
    </div>
  );
}

export default function MetricsBar({ btcPrice, trxPrice, goldPrice, btc24hChange, trx24hChange }: MetricsBarProps) {
  const debasement = (10000 / goldPrice).toFixed(4);
  const trxBtc = (trxPrice / btcPrice);
  const trxBtcTarget = 0.00001697;
  const pairProgress = ((trxBtc / trxBtcTarget) * 100).toFixed(1);

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg flex flex-wrap items-center justify-around divide-x divide-gray-800">
      <Metric label="BTC/USD" value={btcPrice.toLocaleString()} change={btc24hChange} />
      <Metric label="TRX/USD" value={trxPrice.toFixed(4)} change={trx24hChange} />
      <Metric label="Gold" value={goldPrice.toLocaleString()} />
      <Metric label="1/Gold" value={debasement} prefix="" />
      <Metric label="TRX/BTC" value={trxBtc.toFixed(8)} prefix="" />
      <div className="flex flex-col items-center px-4 py-2">
        <div className="text-gray-500 text-xs uppercase tracking-wide">Pair Target</div>
        <div className="text-purple-400 font-mono text-lg font-semibold">{pairProgress}%</div>
        <div className="text-xs text-gray-500">of 3.7x target</div>
      </div>
    </div>
  );
}
