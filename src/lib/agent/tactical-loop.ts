// Tactical agent loop — Haiku-driven, 15m crypto scalps.
import Anthropic from "@anthropic-ai/sdk";
import { TACTICAL_PROMPT } from "./tactical-prompt";
import { TACTICAL_UNIVERSE, TACTICAL_LIMITS } from "./tactical-universe";
import { TOOL_DEFS, handleToolCall, type AgentToolContext } from "./tools";
import { isKillswitchActive } from "./guardrails";
import { reconcileEnv } from "./reconcile";
import type { AgentEnvironment } from "@/lib/neon";

const TACTICAL_MODEL = "claude-haiku-4-5";   // Cheap + fast for pattern matching
const MAX_TOKENS = 4000;
const MAX_TOOL_ITERATIONS = 8;

export interface TacticalRunSummary {
  environment: AgentEnvironment;
  agentKind: "tactical";
  ok: boolean;
  iterations: number;
  toolCalls: { name: string; input: unknown; result: unknown }[];
  finalText: string;
  error?: string;
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
    },
  };

  // ── Reconcile first ──
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

  const now = new Date();
  const initialUser = `Scan time: ${now.toISOString()}
Environment: ${env.toUpperCase()} (TACTICAL — 15m crypto scalps)
Tactical universe: SOL, AVAX, DOGE, BNB, LINK
Max position: $${TACTICAL_LIMITS[env].maxPositionSizeUsd}
${reconcileNote}
Run a quick 15m HVF scan and decide. Most scans → HOLD. Only act on HVF ≥ 70.`;

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
