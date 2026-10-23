/**
 * Read Kiro IDE credentials from `~/.aws/sso/cache/kiro-auth-token.json`.
 *
 * The companion `{clientIdHash}.json` in the same directory provides the
 * OAuth client id/secret needed for IDC token refresh.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Raw shape of `~/.aws/sso/cache/kiro-auth-token.json`. */
interface KiroAuthTokenFile {
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
	region?: string;
	clientIdHash?: string;
	authMethod?: string;
}

/** Raw shape of `~/.aws/sso/cache/{clientIdHash}.json`. */
interface KiroClientFile {
	clientId: string;
	clientSecret: string;
}

/** Parsed Kiro IDE credential. */
export interface KiroIdeCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	region: string;
	clientId: string | undefined;
	clientSecret: string | undefined;
	authMethod: string;
}

function ssoCacheDir(): string {
	return path.join(os.homedir(), ".aws", "sso", "cache");
}

/** Read and parse `kiro-auth-token.json`; returns `undefined` if missing or malformed. */
export async function readKiroIdeCredential(): Promise<KiroIdeCredential | undefined> {
	const tokenPath = path.join(ssoCacheDir(), "kiro-auth-token.json");
	const file = Bun.file(tokenPath);
	const exists = await file.exists();
	if (!exists) return undefined;

	let raw: KiroAuthTokenFile;
	try {
		raw = await file.json();
	} catch {
		return undefined;
	}

	if (!raw.accessToken || !raw.refreshToken || !raw.expiresAt) return undefined;

	const expiresAt = Date.parse(raw.expiresAt);
	if (Number.isNaN(expiresAt)) return undefined;

	let clientId: string | undefined;
	let clientSecret: string | undefined;

	if (raw.clientIdHash) {
		const clientPath = path.join(ssoCacheDir(), `${raw.clientIdHash}.json`);
		const clientFile = Bun.file(clientPath);
		const clientExists = await clientFile.exists();
		if (clientExists) {
			try {
				const clientRaw: KiroClientFile = await clientFile.json();
				clientId = clientRaw.clientId;
				clientSecret = clientRaw.clientSecret;
			} catch {
				// optional; ignore
			}
		}
	}

	return {
		accessToken: raw.accessToken,
		refreshToken: raw.refreshToken,
		expiresAt,
		region: raw.region ?? "us-east-1",
		clientId,
		clientSecret,
		authMethod: raw.authMethod ?? "idc",
	};
}
