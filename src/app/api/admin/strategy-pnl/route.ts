// Per-strategy PnL analytics.
//
// GET /api/admin/strategy-pnl[?env=paper&days=90]
//
// Returns, per strategy:
//   - n_decisions: total open decisions (executed + skipped + failed)
//   - n_trades: how many actually opened (placement succeeded)
//   - n_closed: how many of those closed
//   - n_wins, n_losses, win_rate
//   - total_pnl, avg_pnl, avg_r_multiple
//   - skipped_by_guardrail: count + top reasons
//   - failed: count + top reasons
//
// This is the feedback loop that tells us which experimental strategies
// (trend_break, mean_revert, hvf_mtf) are actually pulling weight on
// paper — vs. which are just generating losing trades and should be
// pruned or retuned. HVF is included as the baseline.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface StrategyStats {
  strategy: string;
  n_decisions: number;
  n_trades: number;
  n_closed: number;
  n_open: number;
  n_wins: number;
  n_losses: number;
  win_rate_pct: number | null;
  total_pnl_usd: number;
  avg_pnl_usd: number | null;
  avg_r_multiple: number | null;
  best_trade_usd: number | null;
  worst_trade_usd: number | null;
  skipped_by_guardrail: number;
  top_guardrail_violations: { violation: string; n: number }[];
  failed: number;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const env = url.searchParams.get("env"); // optional: paper | real | binance
  const days = Number(url.searchParams.get("days") ?? "90");

  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return NextResponse.json({ error: "days must be 1-365" }, { status: 400 });
  }

  try {
    const sql = db();

    // Aggregate per-strategy decision counts + guardrail violation reasons.
    // We filter by env if provided; otherwise aggregate across all envs.
    // Note: strategy column was added in migration 0005 with default 'hvf',
    // so older rows are correctly bucketed.
    const decisionRows = env
      ? (await sql`
          SELECT strategy,
                 outcome_status,
                 guardrail_violation,
                 COUNT(*)::int AS n
            FROM agent_decisions
           WHERE decision_type = 'open'
             AND ts > now() - (${days} || ' days')::interval
             AND environment = ${env}
           GROUP BY strategy, outcome_status, guardrail_violation
        `)
      : (await sql`
          SELECT strategy,
                 outcome_status,
                 guardrail_violation,
                 COUNT(*)::int AS n
            FROM agent_decisions
           WHERE decision_type = 'open'
             AND ts > now() - (${days} || ' days')::interval
           GROUP BY strategy, outcome_status, guardrail_violation
        `);

    // Trade stats per strategy — opened vs closed, PnL, R-multiple.
    const tradeRows = env
      ? (await sql`
          SELECT strategy,
                 status,
                 COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE pnl_usd > 0)::int AS wins,
                 COUNT(*) FILTER (WHERE pnl_usd < 0)::int AS losses,
                 COALESCE(SUM(pnl_usd), 0)::float AS total_pnl,
                 AVG(pnl_usd)::float AS avg_pnl,
                 AVG(r_multiple)::float AS avg_r,
                 MAX(pnl_usd)::float AS best,
                 MIN(pnl_usd)::float AS worst
            FROM trades
           WHERE opened_at > now() - (${days} || ' days')::interval
             AND environment = ${env}
           GROUP BY strategy, status
        `)
      : (await sql`
          SELECT strategy,
                 status,
                 COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE pnl_usd > 0)::int AS wins,
                 COUNT(*) FILTER (WHERE pnl_usd < 0)::int AS losses,
                 COALESCE(SUM(pnl_usd), 0)::float AS total_pnl,
                 AVG(pnl_usd)::float AS avg_pnl,
                 AVG(r_multiple)::float AS avg_r,
                 MAX(pnl_usd)::float AS best,
                 MIN(pnl_usd)::float AS worst
            FROM trades
           WHERE opened_at > now() - (${days} || ' days')::interval
           GROUP BY strategy, status
        `);

    // Bucket into a normalized per-strategy shape.
    const STRATEGIES = ["hvf", "trend_break", "mean_revert", "hvf_mtf"];
    const stats: Record<string, StrategyStats> = {};
    for (const s of STRATEGIES) {
      stats[s] = {
        strategy: s,
        n_decisions: 0,
        n_trades: 0,
        n_closed: 0,
        n_open: 0,
        n_wins: 0,
        n_losses: 0,
        win_rate_pct: null,
        total_pnl_usd: 0,
        avg_pnl_usd: null,
        avg_r_multiple: null,
        best_trade_usd: null,
        worst_trade_usd: null,
        skipped_by_guardrail: 0,
        top_guardrail_violations: [],
        failed: 0,
      };
    }

    // Track per-strategy guardrail violation tallies so we can return top-N
    const violationByStrat: Record<string, Map<string, number>> = {};

    type DecisionRow = {
      strategy: string;
      outcome_status: string;
      guardrail_violation: string | null;
      n: number;
    };
    for (const r of decisionRows as unknown as DecisionRow[]) {
      const s = stats[r.strategy] ?? (stats[r.strategy] = {
        strategy: r.strategy,
        n_decisions: 0, n_trades: 0, n_closed: 0, n_open: 0,
        n_wins: 0, n_losses: 0, win_rate_pct: null,
        total_pnl_usd: 0, avg_pnl_usd: null, avg_r_multiple: null,
        best_trade_usd: null, worst_trade_usd: null,
        skipped_by_guardrail: 0, top_guardrail_violations: [], failed: 0,
      });
      s.n_decisions += r.n;
      if (r.outcome_status === "skipped_guardrail") {
        s.skipped_by_guardrail += r.n;
        if (r.guardrail_violation) {
          const m = violationByStrat[r.strategy] ?? (violationByStrat[r.strategy] = new Map());
          m.set(r.guardrail_violation, (m.get(r.guardrail_violation) ?? 0) + r.n);
        }
      } else if (r.outcome_status === "failed") {
        s.failed += r.n;
      }
    }

    type TradeRow = {
      strategy: string;
      status: string;
      n: number;
      wins: number;
      losses: number;
      total_pnl: number;
      avg_pnl: number | null;
      avg_r: number | null;
      best: number | null;
      worst: number | null;
    };
    for (const r of tradeRows as unknown as TradeRow[]) {
      const s = stats[r.strategy] ?? (stats[r.strategy] = {
        strategy: r.strategy,
        n_decisions: 0, n_trades: 0, n_closed: 0, n_open: 0,
        n_wins: 0, n_losses: 0, win_rate_pct: null,
        total_pnl_usd: 0, avg_pnl_usd: null, avg_r_multiple: null,
        best_trade_usd: null, worst_trade_usd: null,
        skipped_by_guardrail: 0, top_guardrail_violations: [], failed: 0,
      });
      s.n_trades += r.n;
      if (r.status === "closed") {
        s.n_closed += r.n;
        s.n_wins += r.wins;
        s.n_losses += r.losses;
        s.total_pnl_usd += r.total_pnl;
        // avg_pnl / avg_r come back as the AVG over the closed rows.
        // We can't combine averages across rows cleanly here without
        // the count weighting; since status='closed' is one row per
        // strategy in this query, this is fine.
        s.avg_pnl_usd = r.avg_pnl;
        s.avg_r_multiple = r.avg_r;
        s.best_trade_usd = r.best;
        s.worst_trade_usd = r.worst;
      } else {
        s.n_open += r.n;
      }
    }

    // Compute win rate + populate top violations per strategy
    for (const s of Object.values(stats)) {
      const wlTotal = s.n_wins + s.n_losses;
      s.win_rate_pct = wlTotal > 0 ? Number(((s.n_wins / wlTotal) * 100).toFixed(1)) : null;
      const m = violationByStrat[s.strategy];
      if (m) {
        s.top_guardrail_violations = [...m.entries()]
          .map(([violation, n]) => ({ violation, n }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 5);
      }
    }

    // Order: HVF first (baseline), then others by total trades desc
    const ordered = Object.values(stats).sort((a, b) => {
      if (a.strategy === "hvf") return -1;
      if (b.strategy === "hvf") return 1;
      return b.n_trades - a.n_trades;
    });

    return NextResponse.json({
      ok: true,
      env: env || "all",
      days,
      asOf: new Date().toISOString(),
      strategies: ordered,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
