// Main agent loop — one run per cron tick per environment.
// Wraps Claude Opus + tool use + retries.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";
import { TOOL_DEFS, handleToolCall, type AgentToolContext } from "./tools";
import { isKillswitchActive } from "./guardrails";
import type { AgentEnvironment } from "@/lib/neon";

const MODEL = "claude-opus-4-7";              // Smartest model, 1M ctx
const MAX_TOKENS = 8000;
const MAX_TOOL_ITERATIONS = 12;               // Safety cap

export interface AgentRunSummary {
  environment: AgentEnvironment;
  ok: boolean;
  iterations: number;
  toolCalls: { name: string; input: unknown; result: unknown }[];
  finalText: string;
  error?: string;
}

export async function runAgent(env: AgentEnvironment): Promise<AgentRunSummary> {
  const summary: AgentRunSummary = {
    environment: env,
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
  const ctx: AgentToolContext = { environment: env, scanCache: null };

  // Build initial user message with current time + env info
  const now = new Date();
  const initialUser = `Scan time: ${now.toISOString()}
Environment: ${env.toUpperCase()} ${env === "real" ? "(LIVE CAPITAL — be conservative)" : "(PAPER — be active and learn)"}

Run your scan + decision loop now. Start by calling scan_universe and get_open_positions in parallel, then reason about what to do.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: initialUser }];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    summary.iterations++;

    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages,
      });
    } catch (e) {
      summary.error = `Anthropic API error: ${e instanceof Error ? e.message : String(e)}`;
      return summary;
    }

    // Append assistant message
    messages.push({ role: "assistant", content: response.content });

    // Collect any text blocks for the final summary
    const textBlocks = response.content.filter(
      (c): c is Anthropic.TextBlock => c.type === "text",
    );
    if (textBlocks.length > 0) {
      summary.finalText = textBlocks.map((b) => b.text).join("\n");
    }

    // If model didn't request tools, we're done
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

    // Execute all tool calls (sequentially — they may depend on shared ctx)
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

  // Hit iteration cap
  summary.error = `Hit max iterations (${MAX_TOOL_ITERATIONS}) without completing`;
  return summary;
}
