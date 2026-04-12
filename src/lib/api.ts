// Free public APIs for crypto and gold prices

export interface PriceData {
  btc: number;
  trx: number;
  gold: number;
  trxBtc: number;
  btc24hChange: number;
  trx24hChange: number;
  btcMarketCap: number;
  trxMarketCap: number;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// Fetch current prices from CoinGecko
export async function fetchPrices(): Promise<PriceData> {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tron&vs_currencies=usd&include_24hr_change=true&include_market_cap=true",
    { next: { revalidate: 30 } }
  );
  const data = await res.json();

  // Gold from a free metals API (fallback to approximate if fails)
  let goldPrice = 4750; // fallback
  try {
    const goldRes = await fetch(
      "https://api.metalpriceapi.com/v1/latest?api_key=demo&base=XAU&currencies=USD"
    );
    const goldData = await goldRes.json();
    if (goldData?.rates?.USD) goldPrice = goldData.rates.USD;
  } catch {
    // Use fallback
  }

  const btcPrice = data?.bitcoin?.usd || 71000;
  const trxPrice = data?.tron?.usd || 0.32;

  return {
    btc: btcPrice,
    trx: trxPrice,
    gold: goldPrice,
    trxBtc: trxPrice / btcPrice,
    btc24hChange: data?.bitcoin?.usd_24h_change || 0,
    trx24hChange: data?.tron?.usd_24h_change || 0,
    btcMarketCap: data?.bitcoin?.usd_market_cap || 0,
    trxMarketCap: data?.tron?.usd_market_cap || 0,
  };
}

// Fetch historical candles from Binance public API
export async function fetchCandles(
  symbol: string,
  interval: string = "1d",
  limit: number = 200
): Promise<CandleData[]> {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  const data = await res.json();

  return data.map((d: number[]) => ({
    time: Math.floor(d[0] / 1000),
    open: parseFloat(String(d[1])),
    high: parseFloat(String(d[2])),
    low: parseFloat(String(d[3])),
    close: parseFloat(String(d[4])),
    volume: parseFloat(String(d[5])),
  }));
}

// Fetch gold historical (using Binance XAUUSDT as proxy)
export async function fetchGoldCandles(
  interval: string = "1d",
  limit: number = 200
): Promise<CandleData[]> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=XAUUSDT&interval=${interval}&limit=${limit}`
    );
    const data = await res.json();
    return data.map((d: number[]) => ({
      time: Math.floor(d[0] / 1000),
      open: parseFloat(String(d[1])),
      high: parseFloat(String(d[2])),
      low: parseFloat(String(d[3])),
      close: parseFloat(String(d[4])),
    }));
  } catch {
    return [];
  }
}
