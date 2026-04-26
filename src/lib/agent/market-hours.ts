// Asset-class-aware market hours.
// eToro market hours per asset class (UTC):
//   crypto:    24/7 (always open)
//   commodity: CFDs — closed weekends + ~1h daily settlement window
//   equity:    Mon-Fri, NYSE 13:30-20:00 UTC (winter) / 14:30-21:00 (DST)
//   etf:       same as equity
//   index/fx:  ~Sun 22:00 UTC – Fri 22:00 UTC, with daily breaks
//
// Conservative behavior: when uncertain we treat as CLOSED (skip).
// The agent should only TRY to trade markets that are clearly open.

export type AssetClass = "crypto" | "commodity" | "equity" | "etf" | "fx" | "index";

export interface MarketHoursInfo {
  isOpen: boolean;
  reason: string;
  nextOpenUtc?: string;
}

/** Returns true if NYSE-style market hours are active right now. */
function isUsEquityOpen(d: Date): boolean {
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hours = d.getUTCHours();
  const mins = d.getUTCMinutes();
  const minutesIntoDay = hours * 60 + mins;
  // Approx 14:30 - 20:30 UTC covers both EST and EDT regular session.
  return minutesIntoDay >= 14 * 60 + 30 && minutesIntoDay <= 20 * 60 + 30;
}

/** Saturday or Sunday? */
function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export function checkMarketHours(assetClass: AssetClass, when: Date = new Date()): MarketHoursInfo {
  switch (assetClass) {
    case "crypto":
      return { isOpen: true, reason: "Crypto trades 24/7" };

    case "commodity":
      // CFDs (gold/silver) closed on weekends. Also a ~1h daily break
      // around 21:00-22:00 UTC; we don't model that precisely.
      if (isWeekend(when)) {
        return {
          isOpen: false,
          reason: "Commodity CFD market closed on weekends",
          nextOpenUtc: nextWeekdayOpen(when).toISOString(),
        };
      }
      return { isOpen: true, reason: "Commodity CFD market open" };

    case "equity":
    case "etf":
      if (!isUsEquityOpen(when)) {
        return {
          isOpen: false,
          reason: "US equity market closed (weekends or outside 14:30-20:30 UTC)",
          nextOpenUtc: nextEquityOpen(when).toISOString(),
        };
      }
      return { isOpen: true, reason: "US equity market open" };

    case "fx":
    case "index":
      // FX is closed Sat 22:00 UTC – Sun 22:00 UTC; we conservatively
      // treat the whole weekend as closed.
      if (isWeekend(when)) {
        return {
          isOpen: false,
          reason: "FX/index market closed on weekends",
          nextOpenUtc: nextWeekdayOpen(when).toISOString(),
        };
      }
      return { isOpen: true, reason: "FX/index market open" };

    default:
      return { isOpen: false, reason: `Unknown asset class: ${assetClass}` };
  }
}

function nextWeekdayOpen(d: Date): Date {
  const next = new Date(d);
  next.setUTCHours(0, 0, 0, 0);
  while (isWeekend(next) || next <= d) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function nextEquityOpen(d: Date): Date {
  const next = new Date(d);
  // Set to 14:30 UTC same day, walk forward until weekday & in future
  next.setUTCHours(14, 30, 0, 0);
  while (next <= d || isWeekend(next)) {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(14, 30, 0, 0);
  }
  return next;
}
