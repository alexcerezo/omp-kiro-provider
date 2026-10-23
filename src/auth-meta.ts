/**
 * Cache for resolved API region and profile ARN.  Stored as a single
 * "latest" entry so the cache survives access-token rotation: region and
 * profileArn don't change between refreshes for the same account.
 *
 * Persisted to `~/.config/kiro-provider/auth-meta.json`.
 */

import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** Single cache entry. */
export interface AuthMeta {
	apiRegion: string;
	profileArn: string | undefined;
}

/** Persisted cache file shape. */
interface AuthMetaStore {
	latest?: AuthMeta;
}

function cacheFilePath(): string {
	return path.join(os.homedir(), ".config", "kiro-provider", "auth-meta.json");
}

async function readStore(): Promise<AuthMetaStore> {
	const file = Bun.file(cacheFilePath());
	if (!(await file.exists())) return {};
	try {
		return (await file.json()) as AuthMetaStore;
	} catch {
		return {};
	}
}

async function writeStore(store: AuthMetaStore): Promise<void> {
	try {
		// Bun.write creates missing parent directories.
		await Bun.write(cacheFilePath(), JSON.stringify(store, null, 2));
	} catch (err) {
		logger.warn("kiro-provider: failed to write auth-meta cache", { err });
	}
}

/** Look up cached metadata. */
export async function getAuthMeta(): Promise<AuthMeta | undefined> {
	const store = await readStore();
	return store.latest;
}

/** Persist metadata (overwrites previous entry). */
export async function setAuthMeta(_accessToken: string, meta: AuthMeta): Promise<void> {
	const store = await readStore();
	store.latest = meta;
	await writeStore(store);
}
