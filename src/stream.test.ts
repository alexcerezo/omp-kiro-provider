/**
 * Abort settlement for `streamKiro`.
 *
 * omp steers by aborting the in-flight request, and compaction aborts the
 * summarization request the same way (`completeSimple` drains the stream and
 * awaits `result()`). Both used to leave the body-read rejection unhandled,
 * which the Bun binary reports as `[Unhandled Rejection] AbortError` and then
 * exits. These tests drive a real fetch against a local server so the
 * rejection is the platform AbortError, not a mock.
 */

import { afterEach, expect, test } from "bun:test";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { streamKiro, type KiroCredentialResolver } from "./stream";

const realFetch = globalThis.fetch.bind(globalThis);

const model = {
	id: "claude-sonnet-4.5",
	api: "kiro-api",
	provider: "kiro",
	reasoning: false,
} as Model<Api>;

const context = {
	messages: [{ role: "user", content: "Summarize the conversation.", timestamp: 1 }],
} as Context;

let restoreFetch: (() => void) | undefined;
const unhandled: unknown[] = [];

function onUnhandled(err: unknown): void {
	unhandled.push(err);
}

afterEach(() => {
	restoreFetch?.();
	restoreFetch = undefined;
	process.off("unhandledRejection", onUnhandled);
});

function trackUnhandled(): void {
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
}

/** Send every provider fetch to a local server, preserving the caller's signal. */
function proxyFetch(handler: (req: Request) => Response | Promise<Response>): void {
	const server = Bun.serve({ port: 0, fetch: handler });
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		return realFetch(`http://127.0.0.1:${server.port}/`, init);
	}) as typeof fetch;
	restoreFetch = () => {
		globalThis.fetch = realFetch;
		void server.stop(true);
	};
}

function credentials(authMethod: "desktop" | "idc"): KiroCredentialResolver {
	const token = `${authMethod}-${crypto.randomUUID()}`;
	return async () => ({
		accessToken: token,
		apiRegion: "us-east-1",
		profileArn: undefined,
		authMethod,
	});
}

/** AWS event-stream frame. CRC bytes are left zero; the parser does not check them. */
function encodeFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
	const enc = new TextEncoder();
	const headers: [string, string][] = [
		[":message-type", "event"],
		[":event-type", eventType],
	];
	const parts: Uint8Array[] = [];
	for (const [name, value] of headers) {
		const nameBytes = enc.encode(name);
		const valueBytes = enc.encode(value);
		const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
		part[0] = nameBytes.length;
		part.set(nameBytes, 1);
		const typeAt = 1 + nameBytes.length;
		part[typeAt] = 7;
		part[typeAt + 1] = (valueBytes.length >> 8) & 0xff;
		part[typeAt + 2] = valueBytes.length & 0xff;
		part.set(valueBytes, typeAt + 3);
		parts.push(part);
	}
	const headersLength = parts.reduce((sum, part) => sum + part.length, 0);
	const payloadBytes = enc.encode(JSON.stringify(payload));
	const total = 12 + headersLength + payloadBytes.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headersLength, false);
	let offset = 12;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	out.set(payloadBytes, offset);
	return out;
}

function concat(frames: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
	let offset = 0;
	for (const frame of frames) {
		out.set(frame, offset);
		offset += frame.length;
	}
	return out;
}

const helloFrames = concat([
	encodeFrame("assistantResponseEvent", { content: "Hello" }),
	encodeFrame("messageEndEvent", { stopReason: "end_turn" }),
]);

/**
 * What compaction's `completeSimple` does: drain events, then await `result()`.
 * An abort must settle both; it must not reject the iterator or `result()`.
 */
async function drain(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	const hung = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("stream did not settle")), 2000);
	});
	await Promise.race([
		(async () => {
			for await (const event of stream) events.push(event);
		})(),
		hung,
	]);
	const message = await Promise.race([stream.result(), hung]);
	await new Promise(resolve => setTimeout(resolve, 40));
	return { events, message };
}

test("streams a normal response to done", async () => {
	trackUnhandled();
	proxyFetch(() => new Response(helloFrames));
	const stream = streamKiro(model, context, {} as SimpleStreamOptions, credentials("desktop"));
	const { events, message } = await drain(stream);

	expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	expect(message.stopReason).toBe("stop");
	expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	expect(message.duration).toBeGreaterThan(0);
	expect(message.ttft).toBeGreaterThan(0);
	expect(message.ttft).toBeLessThanOrEqual(message.duration ?? 0);
	expect(message.usage.output).toBeGreaterThan(0);
	expect(message.usage.cost.total).toBeGreaterThan(0);
	expect(unhandled).toEqual([]);
});

test("abort before the response arrives settles as aborted", async () => {
	trackUnhandled();
	proxyFetch(() => new Promise(() => {}));
	const controller = new AbortController();
	const stream = streamKiro(
		model,
		context,
		{ signal: controller.signal } as SimpleStreamOptions,
		credentials("desktop"),
	);
	setTimeout(() => controller.abort(), 20);

	const { events, message } = await drain(stream);
	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("Request was aborted");
	expect(message.duration).toBeGreaterThan(0);
	expect(message.ttft).toBeUndefined();
	expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
	expect(events.some(event => event.type === "done")).toBe(false);
	expect(unhandled).toEqual([]);
});

test("abort before a compaction summary response keeps the caller's reason", async () => {
	trackUnhandled();
	proxyFetch(() => new Promise(() => {}));
	const controller = new AbortController();
	const stream = streamKiro(
		model,
		context,
		{ signal: controller.signal } as SimpleStreamOptions,
		credentials("desktop"),
	);
	setTimeout(() => controller.abort("compaction"), 20);

	const { message } = await drain(stream);
	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("compaction");
	expect(unhandled).toEqual([]);
});

test("abort after headers, before the first summary byte, settles as aborted", async () => {
	trackUnhandled();
	proxyFetch(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						// One byte flushes the headers without forming an event frame,
						// so the abort lands in the body reader rather than on fetch itself.
						controller.enqueue(new Uint8Array([0]));
					},
				}),
			),
	);
	const controller = new AbortController();
	const stream = streamKiro(
		model,
		context,
		{ signal: controller.signal } as SimpleStreamOptions,
		credentials("desktop"),
	);
	setTimeout(() => controller.abort(), 30);

	const { events, message } = await drain(stream);
	expect(events[0]?.type).toBe("start");
	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("Request was aborted");
	expect(message.content).toEqual([]);
	expect(events.some(event => event.type === "done")).toBe(false);
	expect(unhandled).toEqual([]);
});

test("abort mid-stream keeps partial text and does not reject", async () => {
	trackUnhandled();
	proxyFetch(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encodeFrame("assistantResponseEvent", { content: "Hello" }));
					},
				}),
			),
	);
	const controller = new AbortController();
	const stream = streamKiro(
		model,
		context,
		{ signal: controller.signal } as SimpleStreamOptions,
		credentials("desktop"),
	);

	const events: AssistantMessageEvent[] = [];
	const hung = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("stream did not settle")), 2000);
	});
	await Promise.race([
		(async () => {
			for await (const event of stream) {
				events.push(event);
				if (event.type === "text_delta") controller.abort();
			}
		})(),
		hung,
	]);
	const message = await Promise.race([stream.result(), hung]);
	await new Promise(resolve => setTimeout(resolve, 40));

	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("Request was aborted");
	expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
	expect(events.some(event => event.type === "done")).toBe(false);
	expect(unhandled).toEqual([]);
});

test("abort during Q profile lookup settles before the summary request", async () => {
	trackUnhandled();
	let calls = 0;
	proxyFetch(req => {
		calls++;
		const target = req.headers.get("x-amz-target") ?? "";
		if (target.includes("ListAvailableProfiles")) return new Promise(() => {});
		return new Response("summary should not start", { status: 500 });
	});
	const controller = new AbortController();
	const stream = streamKiro(model, context, { signal: controller.signal } as SimpleStreamOptions, credentials("idc"));
	setTimeout(() => controller.abort(), 20);

	const { message } = await drain(stream);
	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("Request was aborted");
	expect(calls).toBe(1);
	expect(unhandled).toEqual([]);
});

test("honors fetch, headers, and payload hooks", async () => {
	trackUnhandled();
	globalThis.fetch = (() => {
		throw new Error("global fetch should not run");
	}) as typeof fetch;
	restoreFetch = () => {
		globalThis.fetch = realFetch;
	};

	let sawHeader = false;
	let sawMarker = false;
	let status = 0;
	const stream = streamKiro(
		model,
		context,
		{
			headers: { "x-test-hook": "1" },
			onPayload: body => ({ ...(body as Record<string, unknown>), marker: true }),
			onResponse: response => {
				status = response.status;
			},
			fetch: async (_input, init) => {
				sawHeader = new Headers(init?.headers).get("x-test-hook") === "1";
				sawMarker = JSON.parse(String(init?.body)).marker === true;
				return new Response(helloFrames);
			},
		} as SimpleStreamOptions,
		credentials("desktop"),
	);

	const { message } = await drain(stream);
	expect(message.stopReason).toBe("stop");
	expect(sawHeader).toBe(true);
	expect(sawMarker).toBe(true);
	expect(status).toBe(200);
	expect(unhandled).toEqual([]);
});

test("first-event timeout settles a hung request", async () => {
	trackUnhandled();
	proxyFetch(() => new Promise(() => {}));
	const stream = streamKiro(
		model,
		context,
		{ streamFirstEventTimeoutMs: 40 } as SimpleStreamOptions,
		credentials("desktop"),
	);

	const { message } = await drain(stream);
	expect(message.stopReason).toBe("error");
	expect(message.errorMessage).toContain("first event");
	expect(message.duration).toBeGreaterThan(0);
	expect(unhandled).toEqual([]);
});

test("idle timeout keeps text already streamed", async () => {
	trackUnhandled();
	proxyFetch(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encodeFrame("assistantResponseEvent", { content: "Hello" }));
					},
				}),
			),
	);
	const stream = streamKiro(
		model,
		context,
		{ streamFirstEventTimeoutMs: 2000, streamIdleTimeoutMs: 40 } as SimpleStreamOptions,
		credentials("desktop"),
	);

	const { message } = await drain(stream);
	expect(message.stopReason).toBe("error");
	expect(message.errorMessage).toContain("stalled");
	expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	expect(unhandled).toEqual([]);
});

test("abort mid non-desktop summary stream settles as aborted", async () => {
	trackUnhandled();
	proxyFetch(req => {
		const target = req.headers.get("x-amz-target") ?? "";
		if (target.includes("ListAvailableProfiles")) {
			return Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/p" }] });
		}
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encodeFrame("assistantResponseEvent", { content: "Summary so far" }));
				},
			}),
		);
	});
	const controller = new AbortController();
	const stream = streamKiro(model, context, { signal: controller.signal } as SimpleStreamOptions, credentials("idc"));

	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "text_delta") controller.abort(new Error("summarization cancelled"));
	}
	const message = await stream.result();
	await new Promise(resolve => setTimeout(resolve, 40));

	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("summarization cancelled");
	expect(message.content).toEqual([{ type: "text", text: "Summary so far" }]);
	expect(events.some(event => event.type === "done")).toBe(false);
	expect(unhandled).toEqual([]);
});
