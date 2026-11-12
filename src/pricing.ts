/**
 * Public API rates for Kiro models. Kiro bills in credits, so there is no per-token
 * price; `omp stats` shows an API-equivalent estimate using the first-party rate
 * of the underlying model (Anthropic for `claude-*`), taken from omp's bundled catalog.
 */
import { getBundledModel } from "@oh-my-pi/pi-catalog";

export interface TokenRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Catalog rate (USD per million tokens) for a Kiro model id, or undefined when unpriced. */
export function lookupApiRates(kiroModelId: string): TokenRates | undefined {
	// `claude-sonnet-4.5` (Kiro) → `claude-sonnet-4-5` (catalog).
	const id = kiroModelId.replace(/(\d)\.(\d)/g, "$1-$2");
	if (!id.startsWith("claude-")) return undefined;
	try {
		const cost = getBundledModel("anthropic", id)?.cost;
		if (!cost || (cost.input === 0 && cost.output === 0)) return undefined;
		return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
	} catch {
		return undefined;
	}
}
