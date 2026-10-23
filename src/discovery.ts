/**
 * Map a `SanitizedKiroModelCatalog` to `ProviderModelConfig[]`.
 *
 * Thinking-mode detection is done by inspecting the
 * `additionalModelRequestFieldsSchema` JSON Schema:
 *  - Has `output_config.properties.effort.enum` with Anthropic efforts
 *    → `mode: "anthropic-adaptive"`
 *  - Has `reasoning.properties.effort.enum` with GPT-style efforts
 *    → `mode: "effort"`
 */

import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { SanitizedKiroModelCatalog, SanitizedKiroModel } from "./management";

const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const GPT_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function detectThinkingMode(schema: Record<string, unknown> | undefined): ProviderModelConfig["thinking"] {
	if (!schema) return undefined;

	// Check for Anthropic adaptive thinking: output_config.properties.effort.enum
	const outputConfig = (schema as Record<string, unknown>)["output_config"];
	if (outputConfig && typeof outputConfig === "object") {
		const ocProps = (outputConfig as Record<string, unknown>)["properties"];
		if (ocProps && typeof ocProps === "object") {
			const effortProp = (ocProps as Record<string, unknown>)["effort"];
			if (effortProp && typeof effortProp === "object") {
				const effortEnum = (effortProp as Record<string, unknown>)["enum"];
				if (Array.isArray(effortEnum) && effortEnum.some(e => ANTHROPIC_EFFORTS.has(String(e)))) {
					return {
						mode: "anthropic-adaptive",
						efforts: ["low", "medium", "high", "xhigh", "max"] as const,
					} as ProviderModelConfig["thinking"];
				}
			}
		}
	}

	// Check for GPT-style reasoning: reasoning.properties.effort.enum
	const reasoning = (schema as Record<string, unknown>)["reasoning"];
	if (reasoning && typeof reasoning === "object") {
		const rProps = (reasoning as Record<string, unknown>)["properties"];
		if (rProps && typeof rProps === "object") {
			const effortProp = (rProps as Record<string, unknown>)["effort"];
			if (effortProp && typeof effortProp === "object") {
				const effortEnum = (effortProp as Record<string, unknown>)["enum"];
				if (Array.isArray(effortEnum) && effortEnum.some(e => GPT_EFFORTS.has(String(e)))) {
					return {
						mode: "effort",
						efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] as const,
					} as ProviderModelConfig["thinking"];
				}
			}
		}
	}

	return undefined;
}

function mapInputTypes(supportedInputTypes: readonly string[]): ("text" | "image")[] {
	const types: ("text" | "image")[] = ["text"];
	if (supportedInputTypes.some(t => t === "IMAGE")) {
		types.push("image");
	}
	return types;
}

function mapModel(model: SanitizedKiroModel): ProviderModelConfig {
	const thinking = detectThinkingMode(model.additionalFieldsSchema);
	const reasoning = thinking !== undefined;
	const premiumMultiplier = model.rateMultiplier > 1 ? model.rateMultiplier : undefined;

	return {
		id: model.modelId,
		name: model.modelName,
		reasoning,
		thinking,
		input: mapInputTypes(model.supportedInputTypes),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		premiumMultiplier,
		contextWindow: model.maxInputTokens,
		maxTokens: model.maxOutputTokens,
	};
}

/** Map a sanitised Kiro catalog to an array of `ProviderModelConfig`. */
export function mapKiroModelCatalog(catalog: SanitizedKiroModelCatalog): readonly ProviderModelConfig[] {
	return catalog.models.map(mapModel);
}
