/**
 * Kiro AI provider extension for omp.
 *
 * Registers the "kiro" provider with:
 *  - OAuth login/refresh via Kiro IDE / kiro-cli / device-code flow
 *  - Dynamic model discovery from the Kiro management API
 *  - Custom `streamSimple` using the Kiro binary event-stream protocol
 */

import type { ExtensionFactory, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type {
	Model,
	Api,
	Context,
	SimpleStreamOptions,
	OAuthCredentials,
	AssistantMessageEventStream,
} from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { loginKiro } from "./login";
import { refreshKiroToken } from "./oauth";
import { fetchKiroModelCatalog } from "./management";
import { mapKiroModelCatalog } from "./discovery";
import { streamKiro } from "./stream";
import { DEFAULT_API_REGION, endpointForApiRegion, apiRegionForAwsRegion } from "./models";
import { getAuthMeta, setAuthMeta } from "./auth-meta";
import { decodeKiroApiKey, encodeKiroApiKey } from "./api-key";
import { kiroUsageProvider } from "./usage";

const factory: ExtensionFactory = pi => {
	pi.registerProvider("kiro", {
		api: "kiro-api" as Api,
		baseUrl: endpointForApiRegion(DEFAULT_API_REGION),
		usage: kiroUsageProvider,
		streamSimple: (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const opts = options ?? ({} as SimpleStreamOptions);
			// apiKey is the envelope from getApiKey (token + SSO region + auth method),
			// or a raw access token (env key / peeked token).
			const { token, region, authMethod } = decodeKiroApiKey(typeof opts.apiKey === "string" ? opts.apiKey : "");

			return streamKiro(model, context, opts, async () => {
				if (!token) {
					throw new Error("Kiro credentials not set. Run /login kiro.");
				}
				// Route from the credential itself; the auth-meta cache only fills in
				// the API region for raw tokens that carry no region.
				const apiRegion = region
					? apiRegionForAwsRegion(region)
					: ((await getAuthMeta().catch(() => undefined))?.apiRegion ?? DEFAULT_API_REGION);
				return {
					accessToken: token,
					apiRegion,
					profileArn: undefined,
					authMethod: authMethod ?? "idc",
				};
			});
		},
		oauth: {
			name: "Kiro",
			login: loginKiro,
			refreshToken: refreshKiroToken,
			getApiKey: (credentials: OAuthCredentials): string => encodeKiroApiKey(credentials),
		},
		fetchDynamicModels: async (apiKey: string | undefined): Promise<readonly ProviderModelConfig[]> => {
			// Errors must propagate: the host treats a returned list (even `[]`) as a
			// successful, authoritative catalog, which hides the provider with no
			// diagnostic. A throw keeps the cached catalog and records "unavailable".
			const decoded = apiKey ? decodeKiroApiKey(apiKey) : undefined;
			const token = decoded?.token;
			const catalog = await fetchKiroModelCatalog(token, undefined, decoded?.region, decoded?.authMethod);
			const models = mapKiroModelCatalog(catalog);
			// Cache apiRegion + profileArn as a fallback for raw tokens without routing info.
			if (token) {
				setAuthMeta(token, {
					apiRegion: catalog.apiRegion,
					profileArn: catalog.profileArn,
				}).catch((err: unknown) => {
					logger.warn("kiro-provider: failed to cache auth-meta", { err });
				});
			}
			return models;
		},
	});
};

export default factory;
