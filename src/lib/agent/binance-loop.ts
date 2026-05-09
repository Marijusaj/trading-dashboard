// Binance agent loop — Opus-driven, 6h spot-long crypto scans on USDC.
import Anthropic from "@anthropic-ai/sdk";
import { BINANCE_PROMPT } from "./binance-prompt";
import { BINANCE_TOOL_DEFS, handleBinanceToolCall, type BinanceToolContext } from "./binance-tools";
import { isKillswitchActive } from "./guardrails";
import { reconcileBinance } from "./binance-reconcile";
import { autoManageBinancePositions } from "./binance-manage";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 8000;
const MAX_TOOL_ITERATIONS = 12;

export interface BinanceRunSummary {
  ok: boolean;
  iterations: number;
  toolCalls: { name: string; input: unknown; result: unknown }[];
  finalText: string;
  error?: string;
}

export async function runBinanceAgent(): Promise<BinanceRunSummary> {
  const summary: BinanceRunSummary = {
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

  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    summary.error = "Missing BINANCE_API_KEY or BINANCE_API_SECRET";
    return summary;
  }

  const anthropic = new Anthropic({ apiKey });
  const ctx: BinanceToolContext = { scanCache: null };

  // Reconcile + auto-manage before reasoning
  let reconcileNote = "";
  try {
    const r = await reconcileBinance();
    if (r.closedExternally.length > 0) {
      reconcileNote = `\nReconciliation: ${r.closedExternally.length} position(s) closed externally — ${r.closedExternally.join("; ")}\n`;
    }
    if (r.errors.length > 0) reconcileNote += `Reconcile errors: ${r.errors.join("; ")}\n`;
  } catch (e) {
    reconcileNote = `\nReconcile failed: ${e instanceof Error ? e.message : String(e)}\n`;
  }

  let manageNote = "";
  try {
    const m = await autoManageBinancePositions();
    if (m.closed.length > 0) {
      manageNote = `\nAuto-manager closed ${m.closed.length} position(s) before this scan:\n` +
        m.closed.map((c) => `  - ${c.asset}: ${c.reason}`).join("\n");
    } else if (m.held.length > 0) {
      manageNote = `\nAuto-manager: ${m.held.length} open position(s) still aligned.`;
    }
    if (m.errors.length > 0) manageNote += `\nManage errors: ${m.errors.join("; ")}`;
  } catch (e) {
    manageNote = `\nAuto-manage failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  const now = new Date();
  const initialUser = `Scan time: ${now.toISOString()}
Account: BINANCE SPOT (live USDC, EU MiCA-compliant, long-only)
${reconcileNote}${manageNote}
Run your scan + decision loop now. Start by calling scan_universe, get_open_positions, and get_account_equity in parallel, then reason about what to do.

Important:
- Binance Spot is LONG-ONLY. There is no short. Skip any short signals immediately.
- USDC base. Position size in USDC, max $50 unless balance has grown significantly.
- No SL/TP at platform level — auto-manager handles exits via HVF triggers. The synthetic SL/TP on each trade are for R-multiple math.
- get_account_equity tells you USDC available + value of open base-asset positions.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: initialUser }];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    summary.iterations++;

    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: BINANCE_PROMPT,
        tools: BINANCE_TOOL_DEFS,
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
        result = await handleBinanceToolCall(ctx, tu.name, tu.input);
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
