/**
 * Kiro's client-version gate rejects old identities with HTTP 400 ("This version
 * of Kiro is no longer supported"). The gate keys on the `KiroIDE-<version>`
 * token in the User-Agent, so we identify as the current stable Kiro IDE, read
 * from Kiro's update metadata. Order: KIRO_IDE_VERSION env > fetched metadata > fallback.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";

const FALLBACK_VERSION = "1.4.178";
const METADATA_URL = "https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json";
const TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

let cached: { version: string; at: number } | undefined;

export async function resolveKiroClientVersion(fetchFn: typeof fetch = fetch): Promise<string> {
	const override = (process.env["KIRO_IDE_VERSION"] ?? process.env["KIRO_CLI_VERSION"])?.trim();
	if (override) return override;
	if (cached && Date.now() - cached.at < TTL_MS) return cached.version;
	try {
		const res = await fetchFn(METADATA_URL, { signal: AbortSignal.timeout(3000) });
		if (res.ok) {
			const version = ((await res.json()) as { currentRelease?: unknown }).currentRelease;
			if (typeof version === "string" && VERSION_RE.test(version)) {
				cached = { version, at: Date.now() };
				return version;
			}
		}
	} catch {
		// fall through to the last known version
	}
	// Back off on failure so an unreachable metadata host does not add latency to every request.
	const version = cached?.version ?? FALLBACK_VERSION;
	cached = { version, at: Date.now() };
	return version;
}

/** Stable per-machine id, as the IDE sends (sha256 hex). */
const machineId = createHash("sha256").update(`${os.hostname()}:${os.userInfo().username}`).digest("hex");

/** `user-agent` / `x-amz-user-agent` pair for `generateAssistantResponse`, mirroring the Kiro IDE streaming client. */
export function kiroIdeUserAgent(version: string): { userAgent: string; amzUserAgent: string } {
	const ide = `KiroIDE-${version}-${machineId}`;
	return {
		userAgent: `aws-sdk-js/1.0.0 ua/2.1 os/${os.platform()}#${os.release()} lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.0 m/E ${ide}`,
		amzUserAgent: `aws-sdk-js/1.0.0 ${ide}`,
	};
}
