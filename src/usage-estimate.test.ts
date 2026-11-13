import { expect, test } from "bun:test";
import type { AssistantMessage, Model, Api } from "@oh-my-pi/pi-ai";
import { lookupApiRates } from "./pricing";
import { estimateUsage } from "./stream";

const model = { id: "claude-sonnet-4.5", contextWindow: 200000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
const partial = { content: [{ type: "text", text: "x".repeat(400) }] } as unknown as AssistantMessage;

test("maps dotted Kiro ids to catalog rates", () => {
	expect(lookupApiRates("claude-sonnet-4.5")?.input).toBe(3);
	expect(lookupApiRates("auto")).toBeUndefined();
});

test("derives tokens and equivalent cost from the context percentage", () => {
	const u = estimateUsage(partial, model, {} as never, 10, undefined, undefined);
	expect(u.output).toBe(100);
	expect(u.input).toBe(19900);
	expect(u.cost.total).toBeCloseTo((19900 * 3 + 100 * 15) / 1e6, 8);
	expect(u.premiumRequests).toBeUndefined();
});

test("records a Kiro rate multiplier as premium requests", () => {
	const weighted = { ...model, premiumMultiplier: 1.5 } as Model<Api>;
	expect(estimateUsage(partial, weighted, {} as never, 10, undefined, undefined).premiumRequests).toBe(1.5);
});
