import { afterEach, describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { decodeKiroApiKey, encodeKiroApiKey } from "./api-key";
import { apiRegionForAwsRegion } from "./models";
import {
	packKiroCredentials,
	parseRefreshToken,
	refreshKiroToken,
	unpackKiroCredentials,
	type KiroCredentials,
} from "./oauth";

const realFetch = globalThis.fetch.bind(globalThis);
let restoreFetch: (() => void) | undefined;

afterEach(() => {
	restoreFetch?.();
	restoreFetch = undefined;
});

describe("apiRegionForAwsRegion", () => {
	test("maps EU regions to eu-central-1", () => {
		expect(apiRegionForAwsRegion("eu-central-1")).toBe("eu-central-1");
		expect(apiRegionForAwsRegion("eu-west-1")).toBe("eu-central-1");
		expect(apiRegionForAwsRegion("eu-north-1")).toBe("eu-central-1");
	});

	test("maps US and other regions to us-east-1", () => {
		expect(apiRegionForAwsRegion("us-east-1")).toBe("us-east-1");
		expect(apiRegionForAwsRegion("us-west-2")).toBe("us-east-1");
		expect(apiRegionForAwsRegion("ap-southeast-1")).toBe("us-east-1");
	});
});

describe("unpackKiroCredentials and packKiroCredentials", () => {
	test("unpacks standard 4-part IdC refresh", () => {
		const creds: OAuthCredentials = {
			access: "acc-token",
			refresh: "ref-tok|client-id|client-sec|idc",
			expires: 123456,
			region: "eu-central-1",
		};
		const unpacked = unpackKiroCredentials(creds);
		expect(unpacked.authMethod).toBe("idc");
		expect(unpacked.clientId).toBe("client-id");
		expect(unpacked.clientSecret).toBe("client-sec");
		expect(unpacked.region).toBe("eu-central-1");
		expect(unpacked.apiRegion).toBe("eu-central-1");

		const packed = packKiroCredentials(unpacked);
		expect(packed.refresh).toBe("ref-tok|client-id|client-sec|idc");
		expect(packed.region).toBe("eu-central-1");
	});

	test("unpacks IdC token when explicit authMethod is idc even with < 4 parts", () => {
		const creds: OAuthCredentials & { authMethod?: "idc" | "desktop" } = {
			access: "acc-token",
			refresh: "ref-tok|||idc",
			expires: 123456,
			region: "eu-central-1",
			authMethod: "idc",
		};
		const unpacked = unpackKiroCredentials(creds);
		expect(unpacked.authMethod).toBe("idc");
		expect(unpacked.region).toBe("eu-central-1");
	});

	test("unpacks 2-part IdC refresh suffix", () => {
		const creds: OAuthCredentials = {
			access: "acc-token",
			refresh: "ref-tok|idc",
			expires: 123456,
			region: "eu-central-1",
		};
		const unpacked = unpackKiroCredentials(creds);
		expect(unpacked.authMethod).toBe("idc");
	});

	test("unpacks plain refresh token as idc by default", () => {
		const creds: OAuthCredentials = {
			access: "acc-token",
			refresh: "raw-refresh-token",
			expires: 123456,
			region: "eu-central-1",
		};
		const unpacked = unpackKiroCredentials(creds);
		expect(unpacked.authMethod).toBe("idc");
		expect(unpacked.region).toBe("eu-central-1");
	});

	test("unpacks desktop token with desktop suffix", () => {
		const creds: OAuthCredentials = {
			access: "acc-token",
			refresh: "ref-tok|desktop",
			expires: 123456,
			region: "eu-central-1",
		};
		const unpacked = unpackKiroCredentials(creds);
		expect(unpacked.authMethod).toBe("desktop");
		expect(unpacked.region).toBe("eu-central-1");
		expect(unpacked.apiRegion).toBe("eu-central-1");
	});
});

describe("encodeKiroApiKey and decodeKiroApiKey", () => {
	test("preserves region and authMethod for IdC credentials", () => {
		const creds: OAuthCredentials & Partial<KiroCredentials> = {
			access: "token-123",
			refresh: "refresh-456|id|sec|idc",
			expires: 999999,
			region: "eu-central-1",
			authMethod: "idc",
		};
		const encoded = encodeKiroApiKey(creds);
		const decoded = decodeKiroApiKey(encoded);
		expect(decoded.token).toBe("token-123");
		expect(decoded.region).toBe("eu-central-1");
		expect(decoded.authMethod).toBe("idc");
	});

	test("preserves region and authMethod for desktop credentials", () => {
		const creds: OAuthCredentials & Partial<KiroCredentials> = {
			access: "token-desktop",
			refresh: "refresh-desk|desktop",
			expires: 999999,
			region: "eu-central-1",
			authMethod: "desktop",
		};
		const encoded = encodeKiroApiKey(creds);
		const decoded = decodeKiroApiKey(encoded);
		expect(decoded.token).toBe("token-desktop");
		expect(decoded.region).toBe("eu-central-1");
		expect(decoded.authMethod).toBe("desktop");
	});

	test("decodes raw non-JSON strings", () => {
		const decoded = decodeKiroApiKey("raw-bearer-token");
		expect(decoded.token).toBe("raw-bearer-token");
		expect(decoded.region).toBeUndefined();
		expect(decoded.authMethod).toBeUndefined();
	});
});

describe("refreshKiroToken", () => {
	test("desktop refresh targets prod.us-east-1 and preserves creds.region", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> = {};

		const server = Bun.serve({
			port: 0,
			fetch: async req => {
				capturedUrl = req.url;
				capturedBody = (await req.json()) as Record<string, unknown>;
				return Response.json({
					accessToken: "new-access-token",
					refreshToken: "new-refresh-token",
					expiresIn: 3600,
					profileArn: "arn:aws:kiro::123:profile/abc",
				});
			},
		});

		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("auth.desktop.kiro.dev")) {
				return realFetch(`http://127.0.0.1:${server.port}/refreshToken`, init);
			}
			return realFetch(input, init);
		}) as typeof fetch;

		restoreFetch = () => {
			globalThis.fetch = realFetch;
			void server.stop(true);
		};

		const creds: OAuthCredentials = {
			access: "old-access",
			refresh: "old-refresh|desktop",
			expires: 1000,
			region: "eu-central-1",
		};

		const refreshed = await refreshKiroToken(creds);
		expect(refreshed.access).toBe("new-access-token");
		expect(refreshed.refresh).toBe("new-refresh-token|desktop");
		// Critical: eu-central-1 must NOT be overwritten with us-east-1!
		expect(refreshed.region).toBe("eu-central-1");
	});

	test("IdC refresh uses OIDC endpoint and probes stored region first", async () => {
		let capturedUrl = "";
		const server = Bun.serve({
			port: 0,
			fetch: async req => {
				capturedUrl = req.url;
				return Response.json({
					accessToken: "refreshed-idc-access",
					refreshToken: "refreshed-idc-refresh",
					expiresIn: 3600,
				});
			},
		});

		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("oidc.eu-central-1.amazonaws.com")) {
				return realFetch(`http://127.0.0.1:${server.port}/token`, init);
			}
			return realFetch(input, init);
		}) as typeof fetch;

		restoreFetch = () => {
			globalThis.fetch = realFetch;
			void server.stop(true);
		};

		const creds: OAuthCredentials = {
			access: "old-access",
			refresh: "old-refresh|my-client-id|my-client-secret|idc",
			expires: 1000,
			region: "eu-central-1",
		};

		const refreshed = await refreshKiroToken(creds);
		expect(refreshed.access).toBe("refreshed-idc-access");
		expect(refreshed.refresh).toBe("refreshed-idc-refresh|my-client-id|my-client-secret|idc");
		expect(refreshed.region).toBe("eu-central-1");
	});
});
