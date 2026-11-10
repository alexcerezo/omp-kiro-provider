/**
 * Kiro management API: profile and model discovery.
 *
 * Steps:
 *  1. List profiles → pick the first ARN (or skip for API-key flow)
 *  2. List available models with that profile ARN
 *  3. Sanitize/normalise the catalog
 */

import { logger } from "@oh-my-pi/pi-utils";
import {
	managementEndpointForApiRegion,
	KIRO_API_REGIONS,
	DEFAULT_API_REGION,
	apiRegionForAwsRegion as apiRegionForFallback,
} from "./models";
import { unpackKiroCredentials, refreshRawKiroCredential } from "./oauth";
import { readKiroIdeCredential } from "./kiro-ide";
import { readKiroCliCredential } from "./kiro-cli";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai";

// ---------------------------------------------------------------------------
// Sanitised model types
// ---------------------------------------------------------------------------

export interface SanitizedKiroModel {
	modelId: string;
	modelName: string;
	supportedInputTypes: readonly string[];
	maxInputTokens: number;
	maxOutputTokens: number;
	/** Raw `additionalModelRequestFieldsSchema` from the API. */
	additionalFieldsSchema: Record<string, unknown> | undefined;
	promptCaching: boolean;
	rateMultiplier: number;
}

export interface SanitizedKiroModelCatalog {
	defaultModelId: string | undefined;
	models: readonly SanitizedKiroModel[];
	/** Resolved API region used for this catalog fetch — cache for inference routing. */
	apiRegion: string;
	/** Profile ARN used for this catalog fetch — required for inference. */
	profileArn: string | undefined;
	/** Auth method used — "idc" for enterprise AWS OIDC, "desktop" for kiro-native tokens. */
	authMethod: "idc" | "desktop";
}

// ---------------------------------------------------------------------------
// Internal API types
// ---------------------------------------------------------------------------

interface RawKiroModel {
	modelId: string;
	modelName: string;
	supportedInputTypes?: string[];
	tokenLimits?: {
		maxInputTokens?: number;
		maxOutputTokens?: number;
	};
	additionalModelRequestFieldsSchema?: Record<string, unknown>;
	promptCaching?: {
		supportsPromptCaching?: boolean;
	};
	rateMultiplier?: number;
}

interface ListModelsResponse {
	defaultModel?: { modelId?: string };
	models?: RawKiroModel[];
}

// ---------------------------------------------------------------------------
// Credential/route resolution
// ---------------------------------------------------------------------------

export interface KiroManagementCredential {
	accessToken: string;
	isApiKey: boolean;
	profileArn: string | undefined;
	preferredRegion: string;
	/** Auth method override; only relevant when isApiKey=true (raw access token). */
	authMethod?: "idc" | "desktop";
}

export interface KiroManagementRoute {
	accessToken: string;
	apiRegion: string;
	profileArn: string | undefined;
	authMethod: "idc" | "desktop";
}

/** Build a management credential from either an API key or a stored OAuth token. */
export function resolveKiroManagementCredential(
	apiKey: string | undefined,
	preferredRegion?: string,
	authMethod?: "idc" | "desktop",
): KiroManagementCredential {
	if (apiKey) {
		return {
			accessToken: apiKey,
			isApiKey: true,
			profileArn: undefined,
			preferredRegion: preferredRegion ?? DEFAULT_API_REGION,
			authMethod,
		};
	}
	// Will be resolved at route-resolution time from stored credentials
	return {
		accessToken: "",
		isApiKey: false,
		profileArn: undefined,
		preferredRegion: preferredRegion ?? DEFAULT_API_REGION,
	};
}

/** Resolve the best API region and profile ARN by calling the management API. */
export async function resolveKiroManagementRoute(
	credential: KiroManagementCredential,
	storedCredentials: OAuthCredentials | undefined,
): Promise<KiroManagementRoute> {
	let accessToken = credential.accessToken;
	let preferredRegion = credential.preferredRegion;
	let knownProfileArn: string | undefined = credential.profileArn;
	let authMethod: "idc" | "desktop" = credential.authMethod ?? "desktop";

	if (!credential.isApiKey && storedCredentials) {
		const kiro = unpackKiroCredentials(storedCredentials);
		accessToken = kiro.access;
		preferredRegion = kiro.apiRegion ?? DEFAULT_API_REGION;
		knownProfileArn = kiro.profileArn;
		authMethod = kiro.authMethod;
	}

	if (!accessToken) {
		throw new Error("Kiro: no access token available for management API");
	}

	// If we already have a profileArn, skip profile discovery
	let profileArn = knownProfileArn;

	const regionsToTry = [preferredRegion, ...KIRO_API_REGIONS.filter(r => r !== preferredRegion)];

	for (const region of regionsToTry) {
		const endpoint = managementEndpointForApiRegion(region);

		if (!profileArn) {
			try {
				profileArn = await fetchFirstProfileArn(endpoint, accessToken);
			} catch (err) {
				logger.warn(`kiro-provider: profile list failed in ${region}`, { err });
				continue;
			}
		}

		// Only commit to this region if we have a profileArn (empty = wrong region for this account)
		if (profileArn) {
			return { accessToken, apiRegion: region, profileArn, authMethod };
		}
	}

	// Fall back without profileArn
	return { accessToken, apiRegion: preferredRegion, profileArn: undefined, authMethod };
}

async function fetchFirstProfileArn(endpoint: string, accessToken: string): Promise<string | undefined> {
	// Try ListAvailableProfiles first (works for enterprise IdC tokens).
	const listRes = await fetch(`${endpoint}ListAvailableProfiles`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-amz-json-1.0",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({}),
	});

	if (listRes.ok) {
		const data = (await listRes.json()) as { profiles?: { arn?: string }[] };
		const arn = data.profiles?.[0]?.arn;
		if (arn) return arn;
	}

	// Fall back to GetProfile (works for kiro-native / desktop tokens).
	const getRes = await fetch(`${endpoint}GetProfile`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-amz-json-1.0",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({}),
	});

	if (!getRes.ok) {
		const text = await getRes.text().catch(() => "");
		throw new Error(`GetProfile failed (${getRes.status}): ${text}`);
	}

	const data = (await getRes.json()) as { profile?: { arn?: string } };
	return data.profile?.arn;
}

// ---------------------------------------------------------------------------
// Model catalog fetch
// ---------------------------------------------------------------------------

async function fetchModelsFromEndpoint(
	endpoint: string,
	accessToken: string,
	profileArn: string | undefined,
	apiRegion: string,
	authMethod: "idc" | "desktop",
): Promise<SanitizedKiroModelCatalog> {
	const params = new URLSearchParams({ origin: "KIRO_CLI" });
	if (profileArn) params.set("profileArn", profileArn);

	const res = await fetch(`${endpoint}ListAvailableModels?${params}`, {
		method: "GET",
		headers: {
			"Content-Type": "application/x-amz-json-1.0",
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`ListAvailableModels failed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as ListModelsResponse;
	const models: SanitizedKiroModel[] = (data.models ?? []).map(m => ({
		modelId: m.modelId,
		modelName: m.modelName,
		supportedInputTypes: m.supportedInputTypes ?? ["TEXT"],
		maxInputTokens: m.tokenLimits?.maxInputTokens ?? 200000,
		maxOutputTokens: m.tokenLimits?.maxOutputTokens ?? 64000,
		additionalFieldsSchema: m.additionalModelRequestFieldsSchema,
		promptCaching: m.promptCaching?.supportsPromptCaching ?? false,
		rateMultiplier: m.rateMultiplier ?? 1.0,
	}));

	return {
		defaultModelId: data.defaultModel?.modelId,
		models,
		apiRegion,
		profileArn,
		authMethod,
	};
}

/**
 * Fetch the Kiro model catalog.
 *
 * @param apiKey  Optional API key (undefined uses stored OAuth token).
 * @param storedCredentials  Stored OAuth credentials (used when no API key).
 */
export async function fetchKiroModelCatalog(
	apiKey: string | undefined,
	storedCredentials?: OAuthCredentials,
	preferredRegion?: string,
	authMethod?: "idc" | "desktop",
): Promise<SanitizedKiroModelCatalog> {
	// When both apiKey and storedCredentials are absent, try IDE then kiro-cli
	let effectiveApiKey = apiKey;
	const effectiveStored = storedCredentials;
	let fallbackRegion: string | undefined;
	if (!effectiveApiKey && !effectiveStored) {
		const fallback = (await readKiroIdeCredential()) ?? (await readKiroCliCredential());
		if (fallback) {
			fallbackRegion = fallback.region;
			const isExpired = Date.now() >= fallback.expiresAt - 60_000;
			logger.debug("kiro-provider: using fallback credential", { region: fallback.region, isExpired });
			if (isExpired) {
				try {
					effectiveApiKey = await refreshRawKiroCredential(fallback);
				} catch (err) {
					logger.warn("kiro-provider: fallback token refresh failed", { err });
					effectiveApiKey = fallback.accessToken; // try with expired token anyway
				}
			} else {
				effectiveApiKey = fallback.accessToken;
			}
		} else {
			logger.debug("kiro-provider: no fallback credential found");
		}
	}

	const resolvedRegion = preferredRegion
		? apiRegionForFallback(preferredRegion)
		: (fallbackRegion ? apiRegionForFallback(fallbackRegion) : undefined);

	const credential = resolveKiroManagementCredential(
		effectiveApiKey,
		resolvedRegion,
		authMethod,
	);
	const route = await resolveKiroManagementRoute(credential, effectiveStored);
	logger.debug("kiro-provider: resolved route", { apiRegion: route.apiRegion, hasProfileArn: !!route.profileArn });

	const endpoint = managementEndpointForApiRegion(route.apiRegion);

	try {
		const catalog = await fetchModelsFromEndpoint(
			endpoint,
			route.accessToken,
			route.profileArn,
			route.apiRegion,
			route.authMethod,
		);
		logger.debug("kiro-provider: model catalog fetched", { count: catalog.models.length });
		return catalog;
	} catch (err) {
		// Try alternate regions
		for (const region of KIRO_API_REGIONS) {
			if (region === route.apiRegion) continue;
			try {
				const altEndpoint = managementEndpointForApiRegion(region);
				return await fetchModelsFromEndpoint(
					altEndpoint,
					route.accessToken,
					route.profileArn,
					region,
					route.authMethod,
				);
			} catch (altErr) {
				logger.warn(`kiro-provider: model catalog fetch failed in ${region}`, { err: altErr });
			}
		}
		throw err;
	}
}
