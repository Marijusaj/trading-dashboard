// Tactical agent loop — Haiku-driven, 15m crypto scalps.
import Anthropic from "@anthropic-ai/sdk";
import { TACTICAL_PROMPT } from "./tactical-prompt";
import { TACTICAL_UNIVERSE, TACTICAL_LIMITS } from "./tactical-universe";
import { TOOL_DEFS, handleToolCall, scanOptionsFor, type AgentToolContext } from "./tools";
import { isKillswitchActive, usesManagedStops } from "./guardrails";
import { scanUniverse, type ScanCandidate } from "./scanner";
import { recordObservationDecision } from "./execute";
import { db } from "@/lib/neon";
import { strategiesFor, strategyNamesFor } from "./strategies";
import { reconcileEnv } from "./reconcile";
import { autoManageOpenPositions } from "./manage";
import type { AgentEnvironment } from "@/lib/neon";

const TACTICAL_MODEL = "claude-haiku-4-5";   // Cheap + fast for pattern matching
const MAX_TOKENS = 4000;
const MAX_TOOL_ITERATIONS = 8;

/** A flagged asset is not re-flagged while the agent has looked at it
 *  (any tactical decision naming it) within this window. */
const SETUP_REFLAG_MINUTES = 60;
/** With no setups, still leave one "scanned, nothing" row this often so
 *  the dashboard shows the agent is alive. */
const HEARTBEAT_MINUTES = 360;
/** Other-strategy score bar on paper (same bar the prompt gives the model). */
const PAPER_STRATEGY_SCORE_BAR = 50;

/** Does this scan row clear the env's entry bar? Mirrors the prompt:
 *  real → a computed HVF setup; paper → that, or another strategy > 50. */
export function clearsEntryBar(c: ScanCandidate, env: AgentEnvironment): boolean {
  if (!c.marketIsOpen) return false;
  if (c.hvfSetup) return true;
  return env !== "real" && !!c.strategyCandidates?.some((s) => s.score > PAPER_STRATEGY_SCORE_BAR);
}

/** Symbols worth waking the model for: clear the bar, no open trade on
 *  them in this env, and not already looked at in the re-flag window. */
export async function freshSetups(env: AgentEnvironment, scan: ScanCandidate[]): Promise<string[]> {
  const actionable = scan.filter((c) => clearsEntryBar(c, env)).map((c) => c.symbol);
  if (actionable.length === 0) return [];
  const sql = db();
  const busy = (await sql`
    SELECT asset FROM trades
     WHERE environment = ${env} AND status = 'open'
    UNION
    SELECT asset FROM agent_decisions
     WHERE environment = ${env} AND agent_kind = 'tactical' AND asset IS NOT NULL
       AND ts > now() - (${String(SETUP_REFLAG_MINUTES)} || ' minutes')::interval
  `) as unknown as { asset: string }[];
  const skip = new Set(busy.map((r) => r.asset));
  return actionable.filter((s) => !skip.has(s));
}

/** Record a model-free "nothing to do" row if none was written recently. */
async function heartbeat(env: AgentEnvironment, scan: ScanCandidate[]): Promise<void> {
  const sql = db();
  const rows = (await sql`
    SELECT MAX(ts) AS last_ts FROM agent_decisions
     WHERE environment = ${env} AND agent_kind = 'tactical'
  `) as unknown as { last_ts: string | null }[];
  const last = rows[0]?.last_ts ? new Date(rows[0].last_ts).getTime() : 0;
  if ((Date.now() - last) / 60_000 < HEARTBEAT_MINUTES) return;
  const live = scan
    .filter((c) => c.hvfFunnel.best && ["forming", "triggered"].includes(c.hvfFunnel.best.status))
    .slice(0, 3)
    .map((c) => `${c.symbol} ${c.hvfFunnel.best!.direction} (${c.hvfFunnel.best!.status})`);
  await recordObservationDecision(env, {
    decisionType: "scan_only",
    asset: null,
    reasoning:
      `Code scan (no model call): ${scan.length} assets on 15m, no fresh setup clears the entry bar. ` +
      (live.length ? `Funnels still developing: ${live.join(", ")}.` : `No live funnels.`),
    hvfScore: null,
    conviction: null,
    agentKind: "tactical",
  });
}

export interface TacticalRunSummary {
  environment: AgentEnvironment;
  agentKind: "tactical";
  ok: boolean;
  iterations: number;
  toolCalls: { name: string; input: unknown; result: unknown }[];
  finalText: string;
  error?: string;
  /** Set when the code scan found nothing and the model was not called. */
  skipped?: string;
  /** Symbols the code scan flagged for the model. */
  flagged?: string[];
}

export async function runTacticalAgent(env: AgentEnvironment): Promise<TacticalRunSummary> {
  const summary: TacticalRunSummary = {
    environment: env,
    agentKind: "tactical",
    ok: false,
    iterations: 0,
    toolCalls: [],
    finalText: "",
  };

  if (isKillswitchActive()) {
    summary.error = "Killswitch active (AGENT_DISABLED=true)";
    return summary;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    summary.error = "Missing ANTHROPIC_API_KEY";
    return summary;
  }

  const anthropic = new Anthropic({ apiKey });
  // Inject tactical universe + timeframe + agent_kind into the shared tool context
  const ctx: AgentToolContext = {
    environment: env,
    scanCache: null,
    overrides: {
      universe: TACTICAL_UNIVERSE,
      timeframe: "15m",
      agentKind: "tactical",
      maxPositionSizeUsd: TACTICAL_LIMITS[env].maxPositionSizeUsd,
      // strategies/index.ts is the single source of truth for which
      // strategies an environment runs. Tactical previously omitted this,
      // so it silently ran HVF-only in BOTH envs regardless of what the
      // registry declared. Real still resolves to ["hvf"] via the
      // registry — that gating lives there, not here.
      strategies: strategiesFor(env === "real" ? "real" : "paper"),
    },
  };

  // ── Reconcile + auto-manage existing positions before reasoning ──
  let reconcileNote = "";
  try {
    const r = await reconcileEnv(env);
    const parts: string[] = [];
    if (r.resolved_executed.length) parts.push(`${r.resolved_executed.length} pending order(s) executed`);
    if (r.resolved_cancelled.length) parts.push(`${r.resolved_cancelled.length} pending order(s) cancelled/rejected`);
    if (r.closed_externally.length) parts.push(`${r.closed_externally.length} position(s) closed externally (TP/SL/manual)`);
    if (r.abandoned.length) parts.push(`${r.abandoned.length} stale entry/entries abandoned`);
    if (r.still_pending.length) parts.push(`${r.still_pending.length} order(s) still pending`);
    if (parts.length > 0) reconcileNote = `\nReconciliation: ${parts.join("; ")}\n`;
  } catch (e) {
    reconcileNote = `\nReconcile failed: ${e instanceof Error ? e.message : String(e)}\n`;
  }

  let manageNote = "";
  try {
    const m = await autoManageOpenPositions(env, "tactical");
    if (m.closed.length > 0) {
      manageNote = `\nAuto-managed: closed ${m.closed.length} stale tactical position(s) — ` +
        m.closed.map((c) => `${c.asset}: ${c.reason}`).join(" | ") + "\n";
    }
    if (m.errors.length > 0) manageNote += `Manage errors: ${m.errors.join("; ")}\n`;
  } catch (e) {
    manageNote = `\nAuto-management failed: ${e instanceof Error ? e.message : String(e)}\n`;
  }

  // ── Gate: scan in code, wake the model only for a fresh setup ──────
  // Reconcile and auto-manage above already ran, so open trades are looked
  // after on every pass whether or not the model is called.
  let flagged: string[];
  try {
    const scan = await scanUniverse(scanOptionsFor(ctx));
    flagged = await freshSetups(env, scan);
    if (flagged.length === 0) {
      await heartbeat(env, scan);
      summary.ok = true;
      summary.skipped = `No fresh setup across ${scan.length} assets — model not called`;
      return summary;
    }
  } catch (e) {
    summary.error = `Pre-scan failed: ${e instanceof Error ? e.message : String(e)}`;
    return summary;
  }
  summary.flagged = flagged;

  const managed = usesManagedStops(env);
  const now = new Date();
  const strategyLineup =
    env === "real"
      ? `Strategies enabled: HVF only (real-money discipline).`
      : `Strategies enabled: ${strategyNamesFor("paper").join(", ")}. ` +
        `scan_universe returns strategyCandidates per asset — pick the strategy that best fits the ` +
        `price action and pass its name to open_position. Scores are NOT comparable across strategies.`;
  const initialUser = `Scan time: ${now.toISOString()}
Environment: ${env.toUpperCase()} (TACTICAL — 15m crypto scalps)
${strategyLineup}
Tactical universe (12): SOL, AVAX (long-only), DOGE, BNB, LINK, TRX, XRP, DOT, ATOM, NEAR, INJ, SUI
Max position: $${TACTICAL_LIMITS[env].maxPositionSizeUsd}
Fresh setups flagged by the code scan (you are only called when there is one): ${flagged.join(", ")}
${reconcileNote}${manageNote}
Workflow:
1. get_position_status — quantitative PnL on ANY open tactical trades
2. For each open trade: at +1R consider close_position_partial(0.5); at -0.5R reassess thesis
3. scan_universe (15m, 12 cryptos) — confirm the flagged setups are still there
4. Open what clears the bar${managed ? " — up to 3 new entries this scan, one per asset" : " — max 1 new entry this scan"}; otherwise HOLD.

Constraints:
${managed
  ? `- Stops are AGENT-MANAGED here: use the setup's own stop exactly as compute_risk_plan returns it (no broker padding). A monitor closes the trade when price crosses your stop or target; the broker only holds a wide safety stop.
- No minimum gap between entries and no loss-streak cooldown in this environment.`
  : `- Crypto SHORTS need SL ≥ 5% from entry (eToro min). Tight stops get widened, destroying R:R.`}
- AVAX shorts disallowed (errorCode 747). Long entries OK.
- Auto-manager already closed any positions with degraded HVF.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: initialUser }];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    summary.iterations++;

    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: TACTICAL_MODEL,
        max_tokens: MAX_TOKENS,
        system: TACTICAL_PROMPT,
        tools: TOOL_DEFS,
        messages,
      });
    } catch (e) {
      summary.error = `Anthropic API error: ${e instanceof Error ? e.message : String(e)}`;
      return summary;
    }

    messages.push({ role: "assistant", content: response.content });

    const textBlocks = response.content.filter(
      (c): c is Anthropic.TextBlock => c.type === "text",
    );
    if (textBlocks.length > 0) {
      summary.finalText = textBlocks.map((b) => b.text).join("\n");
    }

    if (response.stop_reason !== "tool_use") {
      summary.ok = true;
      return summary;
    }

    const toolUseBlocks = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      summary.ok = true;
      return summary;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      let result: unknown;
      try {
        result = await handleToolCall(ctx, tu.name, tu.input);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      summary.toolCalls.push({ name: tu.name, input: tu.input, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error:
          typeof result === "object" && result !== null && "error" in result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  summary.error = `Hit max iterations (${MAX_TOOL_ITERATIONS}) without completing`;
  return summary;
}
