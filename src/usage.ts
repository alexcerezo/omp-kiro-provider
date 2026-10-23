/**
 * Kiro usage reporting via `GetUsageLimits` (the call kiro-cli makes for `/usage`).
 *
 * Wire (verified live against q.eu-central-1.amazonaws.com with an IdC token):
 * `POST /` + `X-Amz-Target: AmazonCodeWhispererService.GetUsageLimits`,
 * body `{origin, resourceType, profileArn}`. Each `usageBreakdownList` entry is a
 * metered resource (credits); `currentUsage` already includes overage, so
 * `currentUsage > usageLimit` means the plan allowance is spent and overage is billing.
 */

import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { authMethodFromRefresh } from "./api-key";
import { DEFAULT_API_REGION, apiRegionForAwsRegion, qBaseUrlForApiRegion } from "./models";
import { resolveQProfileArn } from "./q-profile";

const PROVIDER = "kiro";

interface RawUsageBreakdown {
	resourceType?: string;
	displayName?: string;
	displayNamePlural?: string;
	currentUsageWithPrecision?: number;
	currentUsage?: number;
	usageLimitWithPrecision?: number;
	usageLimit?: number;
	overageCapWithPrecision?: number;
	overageCap?: number;
	overageRate?: number;
	overageCharges?: number;
	currency?: string;
	nextDateReset?: number;
}

interface RawUsageLimits {
	nextDateReset?: number;
	overageConfiguration?: { overageStatus?: string };
	subscriptionInfo?: { subscriptionTitle?: string; type?: string };
	usageBreakdownList?: RawUsageBreakdown[];
	userInfo?: { userId?: string };
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toLimit(entry: RawUsageBreakdown, raw: RawUsageLimits, accountId: string | undefined): UsageLimit | undefined {
	const used = finite(entry.currentUsageWithPrecision) ?? finite(entry.currentUsage);
	const limit = finite(entry.usageLimitWithPrecision) ?? finite(entry.usageLimit);
	if (used === undefined || limit === undefined || limit <= 0) return undefined;

	const overageEnabled = raw.overageConfiguration?.overageStatus === "ENABLED";
	const overageCap = overageEnabled ? (finite(entry.overageCapWithPrecision) ?? finite(entry.overageCap) ?? 0) : 0;
	// With overage enabled the account keeps working past the plan allowance, so
	// only the allowance plus the overage cap is a hard stop. An explicit status
	// also keeps rotation from treating `used >= limit` as exhausted.
	const status = used >= limit + overageCap ? "exhausted" : used >= limit ? "warning" : "ok";

	const notes: string[] = [];
	const overage = used - limit;
	if (overage > 0) {
		const charges = finite(entry.overageCharges);
		const cost = charges === undefined ? "" : ` (${charges.toFixed(2)} ${entry.currency ?? "USD"})`;
		notes.push(`Overage: ${overage.toFixed(2)} ${entry.displayNamePlural ?? "credits"}${cost}`);
	}
	if (overageEnabled && overageCap > 0) notes.push(`Overage cap: ${overageCap}`);

	const resetSeconds = finite(entry.nextDateReset) ?? finite(raw.nextDateReset);
	const resourceType = entry.resourceType ?? "CREDIT";
	return {
		id: `kiro:${resourceType.toLowerCase()}`,
		// The host's summary shows "% free" (floored at 0) and clamps bars at 100%, so past
		// the allowance the real percentage goes in the label to keep overage visible.
		label: `${entry.displayNamePlural ?? entry.displayName ?? "Credits"}${used > limit ? ` (${Math.round((used / limit) * 100)}% used)` : ""}`,
		scope: {
			provider: PROVIDER,
			windowId: "monthly",
			...(accountId ? { accountId } : {}),
			...(raw.subscriptionInfo?.type ? { tier: raw.subscriptionInfo.type } : {}),
		},
		window: {
			id: "monthly",
			label: "Monthly",
			...(resetSeconds === undefined ? {} : { resetsAt: resetSeconds * 1000 }),
		},
		// usedFraction stays unclamped (>1 = overage). resolveUsedFraction already derives
		// the same value from used/limit; this feeds renderers that read the field directly.
		amount: {
			used,
			limit,
			remaining: Math.max(0, limit - used),
			usedFraction: used / limit,
			remainingFraction: Math.max(0, 1 - used / limit),
			unit: "credits",
		},
		status,
		...(notes.length > 0 ? { notes } : {}),
	};
}

async function fetchKiroUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const token = params.credential.accessToken ?? params.credential.apiKey;
	if (!token) return null;

	const apiRegion = params.credential.region ? apiRegionForAwsRegion(params.credential.region) : DEFAULT_API_REGION;
	const profileArn = await resolveQProfileArn(token, apiRegion, ctx.fetch);
	if (!profileArn) return null;

	const url = qBaseUrlForApiRegion(apiRegion);
	let raw: RawUsageLimits;
	try {
		const res = await ctx.fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-amz-json-1.0",
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
			},
			body: JSON.stringify({ origin: "KIRO_CLI", resourceType: "AGENTIC_REQUEST", profileArn }),
			signal: params.signal,
		});
		if (!res.ok) {
			// A rejected token must purge the cached report instead of re-serving it.
			if (res.status === 401 || res.status === 403) {
				throw new ProviderHttpError(
					`Kiro GetUsageLimits returned ${res.status} ${res.statusText}`.trim(),
					res.status,
				);
			}
			ctx.logger?.warn("Kiro usage fetch failed", { status: res.status });
			return null;
		}
		raw = (await res.json()) as RawUsageLimits;
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Kiro usage fetch error", { error: String(error) });
		return null;
	}

	const accountId = raw.userInfo?.userId;
	const limits = (raw.usageBreakdownList ?? [])
		.map(entry => toLimit(entry, raw, accountId))
		.filter((limit): limit is UsageLimit => limit !== undefined);
	if (limits.length === 0) return null;

	const title = raw.subscriptionInfo?.subscriptionTitle;
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		...(title ? { notes: [`Plan: ${title}`] } : {}),
		metadata: { endpoint: url, ...(accountId ? { accountId } : {}) },
	};
}

export const kiroUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchKiroUsage,
	// Desktop (kiro-native) tokens are served by runtime.<region>.kiro.dev, whose
	// GetUsageLimits behavior is unverified; only the Q route is supported.
	supports: params =>
		params.provider === PROVIDER &&
		params.credential.type === "oauth" &&
		!!params.credential.accessToken &&
		authMethodFromRefresh(params.credential.refreshToken ?? "") !== "desktop",
	validatesCredentials: true,
};
