/**
 * Kiro "API key" envelope.
 *
 * omp hands `streamSimple` whatever `oauth.getApiKey(credential)` returns. A bare
 * access token loses the routing facts (SSO region, auth method) that decide which
 * inference endpoint accepts the token, so the provider encodes them alongside the
 * token as JSON (same pattern the host uses for github-copilot).
 *
 * Raw (non-JSON) strings — env keys, `authStorage.peek()` tokens used by model
 * discovery — still decode, with routing fields left undefined.
 */

import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { unpackKiroCredentials, type KiroCredentials } from "./oauth";

export type KiroAuthMethod = "idc" | "desktop";

export interface DecodedKiroApiKey {
	token: string;
	/** SSO/OIDC region for IdC tokens; API region for desktop tokens. */
	region: string | undefined;
	authMethod: KiroAuthMethod | undefined;
}

/** Auth method from the packed refresh suffix (`…|desktop` vs `…|idc` / `…|builder-id`). */
export function authMethodFromRefresh(refresh: string | undefined): KiroAuthMethod {
	if (!refresh) return "idc";
	return refresh.endsWith("|desktop") ? "desktop" : "idc";
}

/** Encode a stored credential into the envelope passed to `streamSimple`. */
export function encodeKiroApiKey(creds: OAuthCredentials): string {
	const kiro = unpackKiroCredentials(creds);
	const authMethod = (creds as Partial<KiroCredentials>).authMethod ?? kiro.authMethod;
	const region = creds.region ?? kiro.region ?? kiro.apiRegion;
	return JSON.stringify({
		token: creds.access,
		region,
		authMethod,
	});
}

/** Decode an envelope or a raw access token. */
export function decodeKiroApiKey(apiKey: string): DecodedKiroApiKey {
	if (apiKey.startsWith("{")) {
		try {
			const parsed = JSON.parse(apiKey) as { token?: unknown; region?: unknown; authMethod?: unknown };
			if (typeof parsed.token === "string") {
				return {
					token: parsed.token,
					region: typeof parsed.region === "string" ? parsed.region : undefined,
					authMethod:
						parsed.authMethod === "idc" || parsed.authMethod === "desktop" ? parsed.authMethod : undefined,
				};
			}
		} catch {
			// Not an envelope; fall through and treat it as a raw token.
		}
	}
	return { token: apiKey, region: undefined, authMethod: undefined };
}
