/**
 * Read Kiro CLI credentials from the platform-specific SQLite database.
 *
 * DB path:
 *   Linux:   ~/.config/kiro-cli/data.sqlite3
 *   macOS:   ~/Library/Application Support/Kiro-Cli/data.sqlite3
 *   Windows: %LOCALAPPDATA%\Kiro-Cli\data.sqlite3
 *
 * Table: auth_kv(key TEXT, value TEXT)
 * Keys:
 *   kirocli:odic:token       – IDC token
 *   codewhisperer:odic:token – IDC token (alternate)
 *   kirocli:social:token     – desktop/social token
 */

import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";

/** Raw JSON value stored in auth_kv. */
interface KiroCliTokenValue {
	access_token: string;
	refresh_token: string;
	expires_at: string;
	region?: string;
	profile_arn?: string;
}

/** Parsed Kiro CLI credential. */
export interface KiroCliCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	region: string;
	profileArn: string | undefined;
	authMethod: "idc" | "desktop";
}

function dbPath(): string {
	const platform = process.platform;
	const home = os.homedir();
	if (platform === "darwin") {
		return path.join(home, "Library", "Application Support", "Kiro-Cli", "data.sqlite3");
	}
	if (platform === "win32") {
		const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
		return path.join(localAppData, "Kiro-Cli", "data.sqlite3");
	}
	// Linux / other
	return path.join(home, ".config", "kiro-cli", "data.sqlite3");
}

const IDC_KEYS = ["kirocli:odic:token", "codewhisperer:odic:token"] as const;
const DESKTOP_KEY = "kirocli:social:token";

/** Read the best available credential from the kiro-cli DB; returns `undefined` if not found. */
export async function readKiroCliCredential(): Promise<KiroCliCredential | undefined> {
	const p = dbPath();
	const file = Bun.file(p);
	const exists = await file.exists();
	if (!exists) return undefined;

	let db: Database;
	try {
		db = new Database(p, { readonly: true });
	} catch {
		return undefined;
	}

	try {
		// Try IDC keys first, then desktop
		const keysToTry: Array<{ key: string; method: "idc" | "desktop" }> = [
			...IDC_KEYS.map(key => ({ key, method: "idc" as const })),
			{ key: DESKTOP_KEY, method: "desktop" as const },
		];

		for (const { key, method } of keysToTry) {
			const row = db.query<{ value: string }, [string]>("SELECT value FROM auth_kv WHERE key = ?").get(key);
			if (!row) continue;

			let parsed: KiroCliTokenValue;
			try {
				parsed = JSON.parse(row.value) as KiroCliTokenValue;
			} catch {
				continue;
			}

			if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_at) continue;

			const expiresAt = Date.parse(parsed.expires_at);
			if (Number.isNaN(expiresAt)) continue;

			return {
				accessToken: parsed.access_token,
				refreshToken: parsed.refresh_token,
				expiresAt,
				region: parsed.region ?? "us-east-1",
				profileArn: parsed.profile_arn,
				authMethod: method,
			};
		}

		return undefined;
	} finally {
		db.close();
	}
}
