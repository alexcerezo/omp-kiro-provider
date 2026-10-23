/**
 * Kiro streaming: parse the AWS binary event-stream format and emit
 * `AssistantMessageEvent`s by pushing to an `AssistantMessageEventStream`.
 */

import type {
	Model,
	Api,
	Context,
	SimpleStreamOptions,
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { endpointForApiRegion, qEndpointForApiRegion } from "./models";
import { forgetQProfileArn, resolveQProfileArn } from "./q-profile";
import { buildKiroRequest, type KiroGenerateRequest } from "./transform";

// ---------------------------------------------------------------------------
// Frame parser
// ---------------------------------------------------------------------------

interface EventFrame {
	eventType: string;
	/** `:message-type` header: `event`, or `exception`/`error` for in-stream failures. */
	messageType: string;
	payload: Uint8Array;
}

function parseHeaders(buf: Uint8Array, length: number): Record<string, string> {
	const result: Record<string, string> = {};
	let offset = 0;
	while (offset < length) {
		const nameLen = buf[offset++] ?? 0;
		const name = new TextDecoder().decode(buf.subarray(offset, offset + nameLen));
		offset += nameLen;
		const valueType = buf[offset++]; // 7 = string
		if (valueType !== 7) {
			const valueLen = ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
			offset += 2 + valueLen;
			continue;
		}
		const valueLen = ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
		offset += 2;
		const value = new TextDecoder().decode(buf.subarray(offset, offset + valueLen));
		offset += valueLen;
		result[name] = value;
	}
	return result;
}

async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<EventFrame, void, undefined> {
	const reader = body.getReader();
	let buffer = new Uint8Array(0);

	function append(chunk: Uint8Array): void {
		const next = new Uint8Array(buffer.length + chunk.length);
		next.set(buffer, 0);
		next.set(chunk, buffer.length);
		buffer = next;
	}

	function readUint32BE(offset: number): number {
		return (
			((buffer[offset] ?? 0) << 24) |
			((buffer[offset + 1] ?? 0) << 16) |
			((buffer[offset + 2] ?? 0) << 8) |
			(buffer[offset + 3] ?? 0)
		);
	}

	try {
		while (true) {
			while (buffer.length < 12) {
				const { done, value } = await reader.read();
				if (done) return;
				append(value);
			}

			const totalLength = readUint32BE(0);
			const headersLength = readUint32BE(4);

			while (buffer.length < totalLength) {
				const { done, value } = await reader.read();
				if (done) return;
				append(value);
			}

			const headersStart = 12;
			const headersEnd = headersStart + headersLength;
			const payloadEnd = totalLength - 4; // strip trailing message CRC

			const headersBuf = buffer.subarray(headersStart, headersEnd);
			const payload = buffer.subarray(headersEnd, payloadEnd);
			const headers = parseHeaders(headersBuf, headersLength);

			buffer = buffer.subarray(totalLength);

			const messageType = headers[":message-type"] ?? "event";
			const eventType = headers[":event-type"] ?? headers[":exception-type"] ?? headers[":error-code"] ?? "";
			yield { eventType, messageType, payload };
		}
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// Thinking tag parser
// ---------------------------------------------------------------------------

type Segment = { kind: "text"; content: string } | { kind: "thinking"; content: string };

function splitThinkingTags(text: string): Segment[] {
	const segments: Segment[] = [];
	const tagVariants = [
		{ open: "<thinking>", close: "</thinking>" },
		{ open: "<think>", close: "</think>" },
		{ open: "<reasoning>", close: "</reasoning>" },
	];

	let remaining = text;

	while (remaining.length > 0) {
		let earliest: { idx: number; variant: (typeof tagVariants)[0] } | undefined;
		for (const variant of tagVariants) {
			const idx = remaining.indexOf(variant.open);
			if (idx !== -1 && (earliest === undefined || idx < earliest.idx)) {
				earliest = { idx, variant };
			}
		}

		if (!earliest) {
			segments.push({ kind: "text", content: remaining });
			break;
		}

		if (earliest.idx > 0) {
			segments.push({ kind: "text", content: remaining.slice(0, earliest.idx) });
		}

		const afterOpen = earliest.idx + earliest.variant.open.length;
		const closeIdx = remaining.indexOf(earliest.variant.close, afterOpen);
		if (closeIdx === -1) {
			segments.push({ kind: "thinking", content: remaining.slice(afterOpen) });
			break;
		}

		segments.push({ kind: "thinking", content: remaining.slice(afterOpen, closeIdx) });
		remaining = remaining.slice(closeIdx + earliest.variant.close.length);
	}

	return segments;
}

// ---------------------------------------------------------------------------
// Stop-reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(raw: string): "stop" | "length" | "toolUse" {
	switch (raw) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}

// ---------------------------------------------------------------------------
// Partial AssistantMessage factory
// ---------------------------------------------------------------------------

function makePartial(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function clonePartial(msg: AssistantMessage): AssistantMessage {
	return { ...msg, content: msg.content.slice() };
}

// ---------------------------------------------------------------------------
// Credential resolver type
// ---------------------------------------------------------------------------

/** Async factory called once per request to supply the current access token, region, and profile ARN. */
export type KiroCredentialResolver = () => Promise<{
	accessToken: string;
	apiRegion: string;
	profileArn: string | undefined;
	authMethod?: string;
}>;

// ---------------------------------------------------------------------------
// Core stream function
// ---------------------------------------------------------------------------

/**
 * POST to the Kiro runtime inference endpoint and push `AssistantMessageEvent`s
 * into a returned `AssistantMessageEventStream`.
 *
 * `resolveCredentials` is called once per request just before the fetch so the
 * stream always uses fresh region/profileArn even when credentials were cached
 * after the stream object was created.
 */
export function streamKiro(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	resolveCredentials: KiroCredentialResolver,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		let accessToken: string;
		let apiRegion: string;
		let profileArn: string | undefined;
		let authMethod: string | undefined;

		try {
			({ accessToken, apiRegion, profileArn, authMethod } = await resolveCredentials());
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const errPartial = makePartial(model);
			errPartial.content = [{ type: "text", text: `Kiro: credential error: ${msg}` }];
			errPartial.errorMessage = `Kiro: credential error: ${msg}`;
			errPartial.stopReason = "error";
			stream.push({ type: "error", reason: "error", error: errPartial });
			return;
		}

		// Desktop (kiro-native) tokens use the Kiro runtime; every other token
		// (IdC, Builder ID) uses the Amazon Q endpoint with a Q-resolved profileArn.
		const isDesktop = authMethod === "desktop";
		const endpoint = isDesktop ? endpointForApiRegion(apiRegion) : qEndpointForApiRegion(apiRegion);
		if (!isDesktop) {
			profileArn = await resolveQProfileArn(accessToken, apiRegion);
		}

		let requestBody: KiroGenerateRequest;
		try {
			requestBody = buildKiroRequest(model, context, options, profileArn);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const errPartial = makePartial(model);
			errPartial.content = [{ type: "text", text: `Kiro: request build error: ${msg}` }];
			errPartial.errorMessage = `Kiro: request build error: ${msg}`;
			errPartial.stopReason = "error";
			stream.push({ type: "error", reason: "error", error: errPartial });
			return;
		}

		const modelId = requestBody.conversationState.currentMessage.userInputMessage.modelId;
		logger.debug("kiro-provider: request", { endpoint, modelId, authMethod, hasProfileArn: !!profileArn });

		let res: Response;
		const sdkVersion = "1.28.3";
		const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#${sdkVersion} m/E app/AmazonQ-For-CLI md/appVersion-${sdkVersion}-${crypto.randomUUID().replace(/-/g, "")}`;
		try {
			res = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-amz-json-1.0",
					Accept: "application/json",
					Authorization: `Bearer ${accessToken}`,
					"X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
					"x-amzn-codewhisperer-optout": "true",
					"x-amzn-kiro-agent-mode": "vibe",
					"amz-sdk-invocation-id": crypto.randomUUID(),
					"amz-sdk-request": "attempt=1; max=1",
					"x-amz-user-agent": ua,
					"user-agent": ua,
				},
				body: JSON.stringify(requestBody),
				signal: options?.signal,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("kiro-provider: network error", { endpoint, err: msg });
			const errPartial = makePartial(model);
			errPartial.content = [{ type: "text", text: `Kiro: network error: ${msg}` }];
			errPartial.errorMessage = `Kiro: network error: ${msg}`;
			errPartial.stopReason = options?.signal?.aborted ? "aborted" : "error";
			stream.push({ type: "error", reason: errPartial.stopReason, error: errPartial });
			return;
		}

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			logger.error("kiro-provider: API error", { endpoint, status: res.status, body: text.slice(0, 300) });
			let message = `Kiro API error (${res.status}): ${text}`;
			if (res.status === 403) {
				forgetQProfileArn(accessToken, apiRegion);
				message = `Kiro API error (403): access token rejected — run /login kiro. ${text}`;
			}
			const errPartial = makePartial(model);
			errPartial.content = [{ type: "text", text: message }];
			errPartial.errorMessage = message;
			errPartial.stopReason = "error";
			stream.push({ type: "error", reason: "error", error: errPartial });
			return;
		}

		if (!res.body) {
			const errPartial = makePartial(model);
			errPartial.content = [{ type: "text", text: "Kiro: empty response body" }];
			errPartial.errorMessage = "Kiro: empty response body";
			errPartial.stopReason = "error";
			stream.push({ type: "error", reason: "error", error: errPartial });
			return;
		}

		const partial = makePartial(model);

		stream.push({ type: "start", partial: clonePartial(partial) });

		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		let pendingToolCall: { id: string; name: string; inputStr: string; index: number } | undefined;
		let emittedToolCalls = 0;
		let usage: Usage | undefined;

		// Kiro streams one tool call as several toolUseEvent frames:
		// `{name, toolUseId, input?}`, then `{input: "<chunk>"}`…, then `{stop: true}`.
		const finalizeToolCall = (): void => {
			if (!pendingToolCall) return;
			const tc = partial.content[pendingToolCall.index] as ToolCall;
			const raw = pendingToolCall.inputStr.trim();
			try {
				tc.arguments = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			} catch {
				logger.warn("kiro-provider: failed to parse tool input", { tool: pendingToolCall.name });
				tc.arguments = {};
			}
			stream.push({
				type: "toolcall_end",
				contentIndex: pendingToolCall.index,
				toolCall: tc,
				partial: clonePartial(partial),
			});
			emittedToolCalls++;
			pendingToolCall = undefined;
		};

		for await (const frame of parseEventStream(res.body)) {
			const { eventType, messageType, payload } = frame;

			if (messageType === "exception" || messageType === "error") {
				const raw = new TextDecoder().decode(payload);
				let detail = raw;
				try {
					const parsed = JSON.parse(raw) as { message?: unknown };
					if (typeof parsed.message === "string") detail = parsed.message;
				} catch {
					// keep raw payload text
				}
				const message = `Kiro stream error (${eventType || messageType}): ${detail}`;
				logger.error("kiro-provider: stream exception", { eventType, detail: detail.slice(0, 300) });
				partial.stopReason = "error";
				partial.errorMessage = message;
				stream.push({ type: "error", reason: "error", error: clonePartial(partial) });
				return;
			}

			if (payload.length === 0 && eventType !== "assistantResponseStartedEvent") {
				continue;
			}

			let data: Record<string, unknown> = {};
			if (payload.length > 0) {
				try {
					data = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
				} catch (err) {
					logger.warn("kiro-provider: failed to parse event payload", { eventType, err });
					continue;
				}
			}

			switch (eventType) {
				case "assistantResponseStartedEvent": {
					break;
				}

				case "assistantResponseEvent": {
					const raw = String(data["content"] ?? "");
					const segments = splitThinkingTags(raw);

					for (const seg of segments) {
						if (seg.kind === "thinking") {
							if (thinkingIndex === undefined) {
								thinkingIndex = partial.content.length;
								const block: ThinkingContent = { type: "thinking", thinking: "" };
								partial.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: thinkingIndex,
									partial: clonePartial(partial),
								});
							}
							const thinkingBlock = partial.content[thinkingIndex] as ThinkingContent;
							thinkingBlock.thinking += seg.content;
							stream.push({
								type: "thinking_delta",
								contentIndex: thinkingIndex,
								delta: seg.content,
								partial: clonePartial(partial),
							});
						} else {
							if (!seg.content) continue;

							if (textIndex === undefined) {
								textIndex = partial.content.length;
								const block: TextContent = { type: "text", text: "" };
								partial.content.push(block);
								stream.push({
									type: "text_start",
									contentIndex: textIndex,
									partial: clonePartial(partial),
								});
							}
							const textBlock = partial.content[textIndex] as TextContent;
							textBlock.text += seg.content;
							stream.push({
								type: "text_delta",
								contentIndex: textIndex,
								delta: seg.content,
								partial: clonePartial(partial),
							});
						}
					}
					break;
				}

				case "thinkingEvent": {
					const thinkingDelta = String(data["content"] ?? "");
					if (!thinkingDelta) break;

					if (thinkingIndex === undefined) {
						thinkingIndex = partial.content.length;
						const block: ThinkingContent = { type: "thinking", thinking: "" };
						partial.content.push(block);
						stream.push({
							type: "thinking_start",
							contentIndex: thinkingIndex,
							partial: clonePartial(partial),
						});
					}
					const thinkingBlock = partial.content[thinkingIndex] as ThinkingContent;
					thinkingBlock.thinking += thinkingDelta;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: thinkingDelta,
						partial: clonePartial(partial),
					});
					break;
				}

				case "toolUseEvent": {
					if (textIndex !== undefined) {
						const textBlock = partial.content[textIndex] as TextContent;
						stream.push({
							type: "text_end",
							contentIndex: textIndex,
							content: textBlock.text,
							partial: clonePartial(partial),
						});
						textIndex = undefined;
					}
					if (thinkingIndex !== undefined) {
						const thinkingBlock = partial.content[thinkingIndex] as ThinkingContent;
						stream.push({
							type: "thinking_end",
							contentIndex: thinkingIndex,
							content: thinkingBlock.thinking,
							partial: clonePartial(partial),
						});
						thinkingIndex = undefined;
					}

					const toolUseId = typeof data["toolUseId"] === "string" ? data["toolUseId"] : undefined;
					const toolName = typeof data["name"] === "string" ? data["name"] : undefined;
					const rawInput = data["input"];
					const inputChunk =
						typeof rawInput === "string" ? rawInput : rawInput === undefined ? "" : JSON.stringify(rawInput);

					// A frame for a different tool call closes the pending one.
					if (pendingToolCall && toolUseId && toolUseId !== pendingToolCall.id) {
						finalizeToolCall();
					}

					if (!pendingToolCall && toolUseId && toolName) {
						const tcIndex = partial.content.length;
						const toolCall: ToolCall = { type: "toolCall", id: toolUseId, name: toolName, arguments: {} };
						partial.content.push(toolCall);
						pendingToolCall = { id: toolUseId, name: toolName, inputStr: "", index: tcIndex };
						stream.push({ type: "toolcall_start", contentIndex: tcIndex, partial: clonePartial(partial) });
					}

					if (pendingToolCall && inputChunk) {
						pendingToolCall.inputStr += inputChunk;
						stream.push({
							type: "toolcall_delta",
							contentIndex: pendingToolCall.index,
							delta: inputChunk,
							partial: clonePartial(partial),
						});
					}

					if (data["stop"] === true) finalizeToolCall();
					break;
				}

				case "toolUseEndEvent": {
					finalizeToolCall();
					break;
				}

				case "contextUsageEvent": {
					const usageData = (data["data"] ?? data) as Record<string, unknown>;
					const inputTokens = Number(usageData["inputTokens"] ?? 0);
					const outputTokens = Number(usageData["outputTokens"] ?? 0);
					usage = {
						input: inputTokens,
						output: outputTokens,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: inputTokens + outputTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					break;
				}

				case "messageEndEvent": {
					finalizeToolCall();
					const rawStop = String(data["stopReason"] ?? "end_turn");
					const mapped = mapStopReason(rawStop);
					const stopReason = emittedToolCalls > 0 && mapped === "stop" ? "toolUse" : mapped;

					if (textIndex !== undefined) {
						const textBlock = partial.content[textIndex] as TextContent;
						stream.push({
							type: "text_end",
							contentIndex: textIndex,
							content: textBlock.text,
							partial: clonePartial(partial),
						});
						textIndex = undefined;
					}

					if (thinkingIndex !== undefined) {
						const thinkingBlock = partial.content[thinkingIndex] as ThinkingContent;
						stream.push({
							type: "thinking_end",
							contentIndex: thinkingIndex,
							content: thinkingBlock.thinking,
							partial: clonePartial(partial),
						});
						thinkingIndex = undefined;
					}

					partial.stopReason = stopReason;
					if (usage) partial.usage = usage;

					stream.push({
						type: "done",
						reason: stopReason,
						message: clonePartial(partial),
					});
					return;
				}

				case "codeReferenceEvent": {
					break;
				}

				default: {
					logger.debug(`kiro-provider: unknown event type: ${eventType}`);
					break;
				}
			}
		}

		// Stream ended without messageEndEvent
		finalizeToolCall();
		if (textIndex !== undefined) {
			const textBlock = partial.content[textIndex] as TextContent;
			stream.push({
				type: "text_end",
				contentIndex: textIndex,
				content: textBlock.text,
				partial: clonePartial(partial),
			});
		}
		if (thinkingIndex !== undefined) {
			const thinkingBlock = partial.content[thinkingIndex] as ThinkingContent;
			stream.push({
				type: "thinking_end",
				contentIndex: thinkingIndex,
				content: thinkingBlock.thinking,
				partial: clonePartial(partial),
			});
		}
		const finalReason = emittedToolCalls > 0 ? "toolUse" : "stop";
		partial.stopReason = finalReason;
		if (usage) partial.usage = usage;
		stream.push({ type: "done", reason: finalReason, message: clonePartial(partial) });
	})();

	return stream;
}
