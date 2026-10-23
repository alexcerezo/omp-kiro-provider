/**
 * Amazon Q profile resolution for enterprise IdC / Builder ID tokens.
 *
 * Shared by inference (`stream.ts`) and usage reporting (`usage.ts`); lives in its
 * own module so usage does not pull in the streaming/event-stream stack.
 */

import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { qBaseUrlForApiRegion, qEndpointForApiRegion } from "./models";

const qProfileArnCache = new Map<string, string>();

function qProfileCacheKey(apiRegion: string, accessToken: string): string {
	return `${qEndpointForApiRegion(apiRegion)}:${accessToken.slice(-16)}`;
}

/** Drop the cached profileArn for a token (call after a 403). */
export function forgetQProfileArn(accessToken: string, apiRegion: string): void {
	qProfileArnCache.delete(qProfileCacheKey(apiRegion, accessToken));
}

/** Resolve (and cache per endpoint + token suffix) the first Q profile ARN for a token. */
export async function resolveQProfileArn(
	accessToken: string,
	apiRegion: string,
	fetchImpl: FetchImpl = fetch,
): Promise<string | undefined> {
	const cacheKey = qProfileCacheKey(apiRegion, accessToken);
	const cached = qProfileArnCache.get(cacheKey);
	if (cached) return cached;

	const base = qBaseUrlForApiRegion(apiRegion);
	try {
		const res = await fetchImpl(base, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-amz-json-1.0",
				Authorization: `Bearer ${accessToken}`,
				"X-Amz-Target": "AmazonCodeWhispererService.ListAvailableProfiles",
			},
			body: "{}",
		});
		if (!res.ok) {
			logger.warn("kiro-provider: Q ListAvailableProfiles failed", { status: res.status });
			return undefined;
		}
		const data = (await res.json()) as { profiles?: { arn?: string }[] };
		const arn = data.profiles?.find(p => p.arn)?.arn;
		if (arn) qProfileArnCache.set(cacheKey, arn);
		return arn;
	} catch (err) {
		logger.warn("kiro-provider: Q profile resolution failed", { err });
		return undefined;
	}
}
