/**
 * Token refresh for Kiro OAuth credentials.
 *
 * Two auth methods:
 *  - `idc`     – AWS OIDC endpoint with clientId/clientSecret
 *  - `desktop` – Kiro desktop auth service
 */

import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { IDC_PROBE_REGIONS, KIRO_API_REGIONS, apiRegionForAwsRegion } from "./models";

/**
 * Extended credential type that carries Kiro-specific fields.
 *
 * The `refresh` field is pipe-delimited:
 *   IDC:     `{refreshToken}|{clientId}|{clientSecret}|idc`
 *   Desktop: `{refreshToken}|desktop`
 *
 * `access` holds the raw access token.
 * `expires` is epoch ms.
 */
export interface KiroCredentials extends OAuthCredentials {
	authMethod: "idc" | "desktop";
	clientId: string | undefined;
	clientSecret: string | undefined;
	profileArn: string | undefined;
	apiRegion: string | undefined;
}

/** Pack a KiroCredentials into the standard OAuthCredentials wire shape. */
export function packKiroCredentials(creds: KiroCredentials): OAuthCredentials {
	return {
		access: creds.access,
		expires: creds.expires,
		region: creds.region ?? creds.apiRegion,
		refresh:
			creds.authMethod === "idc"
				? `${parseRefreshToken(creds.refresh)}|${creds.clientId ?? ""}|${creds.clientSecret ?? ""}|${refreshSuffix(creds.refresh, "idc")}`
				: `${parseRefreshToken(creds.refresh)}|desktop`,
	};
}

/** Extract the raw refresh token from the packed `refresh` field. */
export function parseRefreshToken(packed: string): string {
	const idx = packed.indexOf("|");
	return idx === -1 ? packed : packed.slice(0, idx);
}

/** Trailing auth-kind marker of a packed IdC refresh (`idc`, or pi-kiro's `builder-id`). */
function refreshSuffix(packed: string, fallback: string): string {
	const parts = packed.split("|");
	return parts.length >= 4 ? (parts[parts.length - 1] ?? fallback) : fallback;
}

/**
 * Unpack an OAuthCredentials into KiroCredentials.
 *
 * `creds.region` is the SSO/OIDC region for IdC tokens (e.g. `eu-west-1`) and the
 * API region for desktop tokens; `apiRegion` is always derived from it.
 */
export function unpackKiroCredentials(creds: OAuthCredentials): KiroCredentials {
	const parts = creds.refresh.split("|");
	const refreshToken = parts[0] ?? "";
	const apiRegion = creds.region ? apiRegionForAwsRegion(creds.region) : undefined;
	const isIdc = parts.length >= 4 && parts[parts.length - 1] !== "desktop";

	if (isIdc) {
		return {
			...creds,
			refresh: creds.refresh,
			authMethod: "idc",
			clientId: parts[1] || undefined,
			clientSecret: parts[2] || undefined,
			profileArn: undefined,
			apiRegion,
		};
	}

	return {
		...creds,
		refresh: refreshToken,
		authMethod: "desktop",
		clientId: undefined,
		clientSecret: undefined,
		profileArn: undefined,
		apiRegion,
	};
}

/** Refresh response from the IDC OIDC endpoint. */
interface IdcRefreshResponse {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
}

/** Refresh response from the desktop auth endpoint. */
interface DesktopRefreshResponse {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	profileArn?: string;
}

async function refreshIdcToken(
	refreshToken: string,
	clientId: string,
	clientSecret: string,
	region: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
	const url = `https://oidc.${region}.amazonaws.com/token`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			clientId,
			clientSecret,
			refreshToken,
			grantType: "refresh_token",
		}),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Kiro IDC token refresh failed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as IdcRefreshResponse;
	return {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken ?? refreshToken,
		expiresAt: Date.now() + data.expiresIn * 1000,
	};
}

async function refreshDesktopToken(
	refreshToken: string,
	region: string,
	profileArn: string | undefined,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; profileArn?: string }> {
	const url = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
	const body: Record<string, string> = { refreshToken };
	if (profileArn) body["profileArn"] = profileArn;

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Kiro desktop token refresh failed (${res.status}): ${text}`);
	}

	const data = (await res.json()) as DesktopRefreshResponse;
	return {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: Date.now() + data.expiresIn * 1000,
		profileArn: data.profileArn,
	};
}

/** SSO regions to try for an IdC refresh: the stored one first, then the other probe regions. */
function idcRefreshRegions(ssoRegion: string): string[] {
	return [ssoRegion, ...IDC_PROBE_REGIONS.filter(r => r !== ssoRegion)];
}

/**
 * Refresh a Kiro token.  Accepts plain `OAuthCredentials` (unpacks internally)
 * and returns a fresh `OAuthCredentials` packed in the same wire format.
 *
 * IdC: the returned `region` is the SSO/OIDC region whose token endpoint accepted
 * the refresh — never the API region — so a row whose region was previously
 * overwritten with `eu-central-1` heals itself.
 */
export async function refreshKiroToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const kiro = unpackKiroCredentials(credentials);
	const rawRefresh = parseRefreshToken(kiro.refresh);

	if (kiro.authMethod === "idc") {
		const clientId = kiro.clientId;
		const clientSecret = kiro.clientSecret;

		if (!clientId || !clientSecret) {
			throw new Error("Kiro IDC refresh: missing clientId or clientSecret");
		}

		const suffix = refreshSuffix(kiro.refresh, "idc");
		let lastError: unknown;
		for (const r of idcRefreshRegions(credentials.region ?? "us-east-1")) {
			try {
				const result = await refreshIdcToken(rawRefresh, clientId, clientSecret, r);
				return {
					...credentials,
					access: result.accessToken,
					expires: result.expiresAt,
					refresh: `${result.refreshToken}|${clientId}|${clientSecret}|${suffix}`,
					region: r,
				};
			} catch (err) {
				lastError = err;
				logger.warn("kiro-provider: IDC refresh failed", { region: r, status: refreshErrorStatus(err) });
			}
		}

		throw lastError;
	}

	// Desktop auth: `region` already is a Kiro API region.
	const region = kiro.apiRegion ?? "us-east-1";
	let lastError: unknown;
	const regions = [region, ...KIRO_API_REGIONS.filter(r => r !== region)];

	for (const r of regions) {
		try {
			const result = await refreshDesktopToken(rawRefresh, r, kiro.profileArn);
			return {
				...credentials,
				access: result.accessToken,
				expires: result.expiresAt,
				refresh: `${result.refreshToken}|desktop`,
				region: r,
			};
		} catch (err) {
			lastError = err;
			logger.warn("kiro-provider: desktop refresh failed", { region: r, status: refreshErrorStatus(err) });
		}
	}

	throw lastError;
}

/** HTTP status embedded in a refresh error message, without logging the response body. */
function refreshErrorStatus(err: unknown): string | undefined {
	const msg = err instanceof Error ? err.message : String(err);
	return /\((\d{3})\)/.exec(msg)?.[1];
}

/**
 * Refresh a raw Kiro IDE or CLI credential and return a fresh access token.
 * Used by the model discovery flow when the stored IDE/CLI token is expired.
 */
export async function refreshRawKiroCredential(cred: {
	accessToken: string;
	refreshToken: string;
	region: string;
	clientId?: string;
	clientSecret?: string;
	profileArn?: string;
	authMethod?: string;
}): Promise<string> {
	const region = cred.region ?? "us-east-1";
	const isIdc = cred.authMethod === "idc" || (!!cred.clientId && !!cred.clientSecret);

	if (isIdc) {
		if (!cred.clientId || !cred.clientSecret) {
			throw new Error("Kiro IDC refresh: missing clientId or clientSecret");
		}
		let lastError: unknown;
		for (const r of idcRefreshRegions(region)) {
			try {
				const result = await refreshIdcToken(cred.refreshToken, cred.clientId, cred.clientSecret, r);
				return result.accessToken;
			} catch (err) {
				lastError = err;
				logger.warn("kiro-provider: IDC refresh failed", { region: r, status: refreshErrorStatus(err) });
			}
		}
		throw lastError;
	}

	// Desktop auth
	const apiRegion = apiRegionForAwsRegion(region);
	const regions = [apiRegion, ...KIRO_API_REGIONS.filter(r => r !== apiRegion)];
	let lastError: unknown;
	for (const r of regions) {
		try {
			const result = await refreshDesktopToken(cred.refreshToken, r, cred.profileArn);
			return result.accessToken;
		} catch (err) {
			lastError = err;
			logger.warn("kiro-provider: desktop refresh failed", { region: r, status: refreshErrorStatus(err) });
		}
	}
	throw lastError;
}
