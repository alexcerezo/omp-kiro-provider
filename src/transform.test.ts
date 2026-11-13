/**
 * Host options that slash commands and utility turns put on `streamSimple`.
 * Kiro has no developer role and no thinking API field, so both have to land
 * in the user text or the turn drops them.
 */

import { expect, test } from "bun:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildKiroRequest } from "./transform";

const reasoningModel = {
	id: "claude-sonnet-4.5",
	api: "kiro-api",
	provider: "kiro",
	reasoning: true,
} as Model<Api>;

const plainModel = { ...reasoningModel, reasoning: false } as Model<Api>;

const context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
} as Context;

function content(model: Model<Api>, options: SimpleStreamOptions, ctx: Context = context): string {
	return buildKiroRequest(model, ctx, options, undefined).conversationState.currentMessage.userInputMessage.content;
}

test("effort selects the thinking budget", () => {
	expect(content(reasoningModel, { reasoning: "high" })).toContain("<max_thinking_length>30000</max_thinking_length>");
	expect(content(reasoningModel, { reasoning: "max" })).toContain("<max_thinking_length>80000</max_thinking_length>");
	expect(content(reasoningModel, { reasoning: "minimal" })).toContain("<max_thinking_length>10000</max_thinking_length>");
	expect(content(reasoningModel, { reasoning: "high", thinkingBudgets: { high: 1234 } })).toContain(
		"<max_thinking_length>1234</max_thinking_length>",
	);
});

test("utility turns can turn thinking off", () => {
	expect(content(reasoningModel, { reasoning: "high", disableReasoning: true })).not.toContain("thinking_mode");
	expect(content(reasoningModel, { reasoning: "high", forceReasoningOff: true })).not.toContain("thinking_mode");
	expect(content(reasoningModel, { reasoning: "high", minimizeEffort: true })).toContain(
		"<max_thinking_length>10000</max_thinking_length>",
	);
	expect(content(plainModel, { reasoning: "high" })).not.toContain("thinking_mode");
});

test("developer instructions survive as user text", () => {
	const ctx = {
		messages: [
			{ role: "developer", content: "RULE", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		],
	} as Context;
	const text = content(plainModel, {}, ctx);
	expect(text).toContain("RULE");
	expect(text).toContain("hi");
});
