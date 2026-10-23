/**
 * Interactive Kiro login flow.
 *
 * Enterprise IdC: AWS SSO OIDC device code flow (register → device_authorization → poll /token).
 * Builder ID / GitHub / Google: kiro-native device code flow via prod.us-east-1.auth.desktop.kiro.dev.
 *
 * Credential hierarchy (checked in order):
 *  1. Kiro IDE token from ~/.aws/sso/cache/kiro-auth-token.json  (desktop-issued)
 *  2. kiro-cli SQLite DB (desktop-issued)
 *  3. Interactive device-code flow via kiro-native auth server
 *
 * Returns an `OAuthCredentials` whose `refresh` is packed per the
 * KiroCredentials wire format (see oauth.ts).
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { readKiroIdeCredential } from "./kiro-ide";
import { readKiroCliCredential } from "./kiro-cli";
import type { KiroCredentials } from "./oauth";
import { apiRegionForAwsRegion, IDC_PROBE_REGIONS, KIRO_API_REGIONS } from "./models";
/** Kiro-native auth server base URL. */
// ---------------------------------------------------------------------------
// AWS SSO OIDC device code flow (enterprise IdC)
// ---------------------------------------------------------------------------

const SSO_SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
	"codewhisperer:transformations",
	"codewhisperer:taskassist",
];

const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

interface SsoRegisterResult {
	clientId: string;
	clientSecret: string;
	oidcEndpoint: string;
	devAuth: SsoDeviceAuth;
}

interface SsoDeviceAuth {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}

async function ssoTryRegisterAndAuthorize(startUrl: string, region: string): Promise<SsoRegisterResult | null> {
	const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;
	const regResp = await fetch(`${oidcEndpoint}/client/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "omp-kiro-provider" },
		body: JSON.stringify({
			clientName: "omp-kiro-provider",
			clientType: "public",
			scopes: SSO_SCOPES,
			grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
		}),
	});
	if (!regResp.ok) return null;
	const { clientId, clientSecret } = (await regResp.json()) as { clientId: string; clientSecret: string };
	const devResp = await fetch(`${oidcEndpoint}/device_authorization`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "omp-kiro-provider" },
		body: JSON.stringify({ clientId, clientSecret, startUrl }),
	});
	if (!devResp.ok) return null;
	return { clientId, clientSecret, oidcEndpoint, devAuth: (await devResp.json()) as SsoDeviceAuth };
}

async function ssoPollForToken(
	oidcEndpoint: string,
	clientId: string,
	clientSecret: string,
	devAuth: SsoDeviceAuth,
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const deadline = Date.now() + (devAuth.expiresIn || 600) * 1000;
	const baseInterval = (devAuth.interval || 5) * 1000;
	let interval = baseInterval;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		await Bun.sleep(interval);
		if (signal?.aborted) throw new Error("Login cancelled");
		let resp: Response;
		try {
			resp = await fetch(`${oidcEndpoint}/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "User-Agent": "omp-kiro-provider" },
				body: JSON.stringify({
					clientId,
					clientSecret,
					deviceCode: devAuth.deviceCode,
					grantType: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			});
		} catch {
			continue;
		}
		if (resp.status >= 500) continue;
		let data: Record<string, unknown>;
		try {
			data = (await resp.json()) as Record<string, unknown>;
		} catch {
			if (!resp.ok) throw new Error(`Authorization failed: HTTP ${resp.status}`);
			continue;
		}
		if (!data["error"] && data["accessToken"] && data["refreshToken"]) {
			return data as unknown as { accessToken: string; refreshToken: string; expiresIn: number };
		}
		if (data["error"] === "authorization_pending") continue;
		if (data["error"] === "slow_down") {
			interval += baseInterval;
			continue;
		}
		if (data["error"]) throw new Error(`Authorization failed: ${String(data["error"])}`);
	}
	throw new Error("Authorization timed out");
}

async function performIdcDeviceCodeLogin(callbacks: OAuthLoginCallbacks): Promise<KiroCredentials> {
	const startUrlRaw = await callbacks.onPrompt({
		message: "Enter your IAM Identity Center start URL (e.g. https://mycompany.awsapps.com/start):",
		placeholder: "https://mycompany.awsapps.com/start",
	});
	const startUrl = startUrlRaw.trim();
	if (!startUrl.startsWith("http")) {
		throw new Error(`Invalid start URL "${startUrl}"`);
	}

	const regionRaw = await callbacks.onPrompt({
		message: `Identity Center region, or blank to auto-detect (${IDC_PROBE_REGIONS.join(", ")}):`,
		placeholder: "us-east-1",
		allowEmpty: true,
	});
	const region = regionRaw.trim();
	const regions = region ? [region] : IDC_PROBE_REGIONS;

	callbacks.onProgress?.(region ? `Connecting to ${region}…` : "Detecting your Identity Center region…");

	let result: SsoRegisterResult | null = null;
	let detectedRegion = "";
	for (const r of regions) {
		result = await ssoTryRegisterAndAuthorize(startUrl, r);
		if (result) {
			detectedRegion = r;
			break;
		}
	}
	if (!result || !detectedRegion) {
		throw new Error(`Could not connect to ${startUrl} in any of: ${regions.join(", ")}`);
	}

	callbacks.onAuth({
		url: result.devAuth.verificationUriComplete,
		instructions: `Open this URL to authorize:\n${result.devAuth.verificationUriComplete}\n\nCode: ${result.devAuth.userCode}\n\nComplete within 10 minutes.`,
	});
	callbacks.onProgress?.("Waiting for browser authorization…");

	const tok = await ssoPollForToken(
		result.oidcEndpoint,
		result.clientId,
		result.clientSecret,
		result.devAuth,
		callbacks.signal,
	);

	const apiRegion = apiRegionForAwsRegion(detectedRegion);
	return {
		access: tok.accessToken,
		expires: Date.now() + (tok.expiresIn ?? 3600) * 1000 - EXPIRES_BUFFER_MS,
		refresh: `${tok.refreshToken}|${result.clientId}|${result.clientSecret}|idc`,
		region: detectedRegion,
		authMethod: "idc",
		clientId: result.clientId,
		clientSecret: result.clientSecret,
		profileArn: undefined,
		apiRegion,
	};
}

// ---------------------------------------------------------------------------
// Kiro-native device code flow (Builder ID / GitHub / Google)
// ---------------------------------------------------------------------------

/** Kiro-native auth server base URL. */
const KIRO_AUTH_BASE = "https://prod.us-east-1.auth.desktop.kiro.dev";

/** Client ID used for the kiro-native device flow. */
const KIRO_CLIENT_ID = "kiro-cli";

/** Supported login providers for the kiro-native device flow. */
export type KiroLoginProvider = "Cognito" | "Github" | "Google";

/** Response from /oauth/device/authorization */
interface KiroDeviceAuthResponse {
	deviceCode: string;
	expiresInMilliseconds: number;
	intervalInMilliseconds: number;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
}

/** Response from /oauth/device/poll */
interface KiroDevicePollResponse {
	status: string;
	accessToken: string | null;
	refreshToken: string | null;
	profileArn: string | null;
	identityProvider: string | null;
}

async function kiroStartDeviceAuth(loginProvider: KiroLoginProvider): Promise<KiroDeviceAuthResponse> {
	const res = await fetch(`${KIRO_AUTH_BASE}/oauth/device/authorization`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ clientId: KIRO_CLIENT_ID, loginProvider }),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Kiro device authorization failed (${res.status}): ${text}`);
	}
	return (await res.json()) as KiroDeviceAuthResponse;
}

async function kiroPollForToken(
	deviceCode: string,
	intervalMs: number,
	expiresMs: number,
	signal?: AbortSignal,
): Promise<KiroDevicePollResponse> {
	const deadline = Date.now() + expiresMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		await Bun.sleep(intervalMs);
		if (signal?.aborted) throw new Error("Login cancelled");

		const res = await fetch(`${KIRO_AUTH_BASE}/oauth/device/poll`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ deviceCode, clientId: KIRO_CLIENT_ID }),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Kiro device poll failed (${res.status}): ${text}`);
		}

		const data = (await res.json()) as KiroDevicePollResponse;
		if (data.status === "authorization_pending") continue;
		if (data.accessToken) return data;
		throw new Error(`Kiro device poll unexpected status: ${data.status}`);
	}
	throw new Error("Kiro device code expired");
}

async function performKiroDeviceCodeLogin(
	callbacks: OAuthLoginCallbacks,
	loginProvider: KiroLoginProvider,
): Promise<KiroCredentials> {
	callbacks.onProgress?.("Starting Kiro device authorization...");

	const authz = await kiroStartDeviceAuth(loginProvider);

	callbacks.onAuth({
		url: authz.verificationUriComplete,
		instructions: `Open this URL to sign in to Kiro:\n${authz.verificationUri}\n\nUser code: ${authz.userCode}`,
	});

	callbacks.onProgress?.("Waiting for browser authorization...");

	const token = await kiroPollForToken(
		authz.deviceCode,
		authz.intervalInMilliseconds,
		authz.expiresInMilliseconds,
		callbacks.signal,
	);

	if (!token.accessToken || !token.refreshToken) {
		throw new Error("Kiro device flow: missing access or refresh token in response");
	}

	// Use profile ARN from token response; fall back to us-east-1 for Builder ID
	const profileArn = token.profileArn ?? undefined;

	// Infer API region from profileArn if present, else use us-east-1
	let apiRegion = "us-east-1";
	if (profileArn) {
		const parts = profileArn.split(":");
		if (parts.length >= 4 && parts[3]) {
			apiRegion = apiRegionForAwsRegion(parts[3]);
		}
	}

	return {
		access: token.accessToken,
		expires: Date.now() + 8 * 60 * 60 * 1000, // kiro tokens last ~8h
		refresh: `${token.refreshToken}|desktop`,
		region: apiRegion,
		authMethod: "desktop",
		clientId: undefined,
		clientSecret: undefined,
		profileArn,
		apiRegion,
	};
}

/**
 * Attempt login using Kiro IDE credentials (desktop-issued or enterprise IdC).
 * Returns `undefined` if not available or expired.
 */
async function tryKiroIdeLogin(): Promise<KiroCredentials | undefined> {
	const cred = await readKiroIdeCredential();
	if (!cred) return undefined;
	// An expired IDE token would be stored as a "successful" login, then fail every
	// discovery/inference call. Skip it so the interactive login runs instead.
	// (Refreshing here would rotate the IDE's own refresh token behind its back.)
	if (cred.expiresAt <= Date.now() + 60_000) {
		logger.debug("kiro-provider: Kiro IDE credential expired — skipping");
		return undefined;
	}
	const apiRegion = apiRegionForAwsRegion(cred.region);
	// Accept both desktop-issued (kiro-native) and enterprise IdC (AWS OIDC) tokens.
	// Enterprise IdC tokens carry clientId/clientSecret for refresh; profileArn is
	// resolved later by the management API route resolution.
	if (cred.clientId && cred.clientSecret) {
		// Enterprise IdC token
		return {
			access: cred.accessToken,
			expires: cred.expiresAt,
			refresh: `${cred.refreshToken}|${cred.clientId}|${cred.clientSecret}|idc`,
			// `region` is the SSO/OIDC region (needed for refresh); the API region is derived from it.
			region: cred.region,
			authMethod: "idc",
			clientId: cred.clientId,
			clientSecret: cred.clientSecret,
			profileArn: undefined,
			apiRegion,
		};
	}

	// Desktop-issued (kiro-native) token
	return {
		access: cred.accessToken,
		expires: cred.expiresAt,
		refresh: `${cred.refreshToken}|desktop`,
		region: apiRegion,
		authMethod: "desktop",
		clientId: undefined,
		clientSecret: undefined,
		profileArn: undefined,
		apiRegion,
	};
}

/**
 * Attempt login using kiro-cli DB credentials (desktop-issued).
 * Returns `undefined` if not available or expired.
 */
async function tryKiroCliLogin(): Promise<KiroCredentials | undefined> {
	const cred = await readKiroCliCredential();
	if (!cred) return undefined;
	if (cred.expiresAt <= Date.now() + 60_000) return undefined;

	// Only use if desktop-issued (not enterprise IdC via AWS OIDC)
	if (cred.authMethod === "idc") {
		logger.debug("kiro-provider: kiro-cli credential is IdC — skipping");
		return undefined;
	}

	const apiRegion = apiRegionForAwsRegion(cred.region);
	return {
		access: cred.accessToken,
		expires: cred.expiresAt,
		refresh: `${cred.refreshToken}|desktop`,
		region: apiRegion,
		authMethod: "desktop",
		clientId: undefined,
		clientSecret: undefined,
		profileArn: cred.profileArn,
		apiRegion,
	};
}

/**
 * Main login entry point.
 *
 * 1. Try Kiro IDE desktop token (non-expired)
 * 2. Try kiro-cli desktop DB token (non-expired)
 * 3. Ask user which login method, then run appropriate flow
 */
export async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	// 1. Kiro IDE token (desktop-issued only)
	const ideCred = await tryKiroIdeLogin().catch(err => {
		logger.warn("kiro-provider: IDE credential check failed", { err });
		return undefined;
	});
	if (ideCred) {
		callbacks.onProgress?.("Using existing Kiro IDE credentials");
		return ideCred;
	}

	// 2. kiro-cli DB token (desktop-issued only)
	const cliCred = await tryKiroCliLogin().catch(err => {
		logger.warn("kiro-provider: kiro-cli credential check failed", { err });
		return undefined;
	});
	if (cliCred) {
		callbacks.onProgress?.("Using existing kiro-cli credentials");
		return cliCred;
	}

	// 3. Interactive login — choose method
	const choice = await callbacks.onPrompt({
		message:
			"Choose Kiro login method:\n" +
			"  1. Enterprise / IAM Identity Center (browser)\n" +
			"  2. Builder ID (personal — Cognito)\n" +
			"  3. GitHub\n" +
			"  4. Google\n" +
			"Enter 1, 2, 3, or 4:",
		placeholder: "1",
	});

	switch (choice.trim()) {
		case "1":
			return performIdcDeviceCodeLogin(callbacks);
		case "2":
			return performKiroDeviceCodeLogin(callbacks, "Cognito");
		case "3":
			return performKiroDeviceCodeLogin(callbacks, "Github");
		case "4":
			return performKiroDeviceCodeLogin(callbacks, "Google");
		default:
			return performIdcDeviceCodeLogin(callbacks);
	}
}

/** Infer the preferred API region from stored credentials (used by discovery). */
export function inferKiroApiRegion(credentials: OAuthCredentials): string {
	// region stored in OAuthCredentials.region field
	return credentials.region ?? KIRO_API_REGIONS[0] ?? "us-east-1";
}
