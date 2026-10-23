/**
 * Endpoint routing helpers for the Kiro API.
 *
 * Regional API-region resolution: all AWS regions map to one of two
 * Kiro API regions — `us-east-1` (US / APAC) or `eu-central-1` (EU).
 */

/**
 * Resolve an AWS region to a Kiro API region.
 * US/APAC regions → `us-east-1`; EU regions (incl. eu-central-*) → `eu-central-1`.
 */
export function apiRegionForAwsRegion(region: string): string {
	return region.startsWith("eu-") ? "eu-central-1" : "us-east-1";
}

/** AWS SSO OIDC regions probed for IAM Identity Center login and token refresh. */
export const IDC_PROBE_REGIONS: readonly string[] = [
	"us-east-1",
	"eu-west-1",
	"eu-central-1",
	"us-east-2",
	"eu-west-2",
	"eu-west-3",
	"eu-north-1",
	"ap-southeast-1",
	"ap-northeast-1",
	"us-west-2",
];

/**
 * Normalize an omp model id to the Kiro wire id (`claude-sonnet-4-6` → `claude-sonnet-4.6`).
 * Dotted ids returned by discovery are left unchanged.
 */
export function toKiroModelId(id: string): string {
	return id.replace(/(\d)-(\d)/g, "$1.$2");
}

/** Runtime inference endpoint for a Kiro API region (kiro-native / desktop tokens). */
export function endpointForApiRegion(apiRegion: string): string {
	return `https://runtime.${apiRegion}.kiro.dev/generateAssistantResponse`;
}

/** Amazon Q inference endpoint for enterprise IdC tokens. */
export function qEndpointForApiRegion(apiRegion: string): string {
	return `https://q.${apiRegion}.amazonaws.com/generateAssistantResponse`;
}

/** Amazon Q base URL for profile/model discovery (enterprise IdC tokens). */
export function qBaseUrlForApiRegion(apiRegion: string): string {
	return `https://q.${apiRegion}.amazonaws.com/`;
}

/** Management endpoint for a Kiro API region. */
export function managementEndpointForApiRegion(apiRegion: string): string {
	return `https://management.${apiRegion}.kiro.dev/`;
}

/** The two canonical Kiro API regions tried in order for management discovery. */
export const KIRO_API_REGIONS: readonly string[] = ["us-east-1", "eu-central-1"];

/** Default Kiro API region when none is known. */
export const DEFAULT_API_REGION = "us-east-1";

/** API key endpoint base URL (no regional routing). */
export const KIRO_API_KEY_ENDPOINT = "https://api.kiro.dev/ide/v1/";
