/**
 * Kiro rejects clients older than its minimum supported CLI version (HTTP 400),
 * so the advertised version tracks Kiro's published latest release instead of a
 * hardcoded constant. Order: KIRO_CLI_VERSION env > cached/fetched manifest > fallback.
 */
const FALLBACK_VERSION = "3.3.0";
const MANIFEST_URL = "https://prod.download.cli.kiro.dev/stable/latest/manifest.json";
const TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

let cached: { version: string; at: number } | undefined;

export async function resolveKiroClientVersion(fetchFn: typeof fetch = fetch): Promise<string> {
	const override = process.env["KIRO_CLI_VERSION"]?.trim();
	if (override) return override;
	if (cached && Date.now() - cached.at < TTL_MS) return cached.version;
	try {
		const res = await fetchFn(MANIFEST_URL, { signal: AbortSignal.timeout(3000) });
		if (res.ok) {
			const version = ((await res.json()) as { version?: unknown }).version;
			if (typeof version === "string" && VERSION_RE.test(version)) {
				cached = { version, at: Date.now() };
				return version;
			}
		}
	} catch {
		// fall through to the last known version
	}
	// Back off on failure so an offline manifest does not add latency to every request.
	const version = cached?.version ?? FALLBACK_VERSION;
	cached = { version, at: Date.now() };
	return version;
}
