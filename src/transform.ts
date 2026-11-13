/**
 * Build a Kiro `GenerateAssistantResponse` request body from an OMP `Context`.
 *
 * Wire shape matches what the Q / CodeWhisperer streaming service accepts
 * (same contract as the pi-kiro reference plugin):
 *  - the system prompt is prepended to the first user message (no top-level field);
 *  - tools live in `currentMessage.userInputMessage.userInputMessageContext.tools`;
 *  - tool results are sent as a user turn *after* the assistant turn that called them;
 *  - every `userInputMessage` carries `modelId`.
 */

import type {
	Model,
	Api,
	Context,
	SimpleStreamOptions,
	Message,
	AssistantMessage,
	TextContent,
	ImageContent,
	ToolResultMessage,
	Tool,
} from "@oh-my-pi/pi-ai";
import { toKiroModelId } from "./models";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface KiroToolResult {
	toolUseId: string;
	content: { text: string }[];
	status: "success" | "error";
}

interface KiroToolSpecification {
	toolSpecification: {
		name: string;
		description: string;
		inputSchema: { json: Record<string, unknown> };
	};
}

interface KiroUserInputMessageContext {
	toolResults?: KiroToolResult[];
	tools?: KiroToolSpecification[];
}

interface KiroImageInput {
	format: string;
	source: { bytes: string };
}

interface KiroUserInputMessage {
	content: string;
	modelId: string;
	origin: "KIRO_CLI";
	images?: KiroImageInput[];
	userInputMessageContext?: KiroUserInputMessageContext;
}

interface KiroToolUse {
	name: string;
	toolUseId: string;
	input: Record<string, unknown>;
}

interface KiroAssistantResponseMessage {
	content: string;
	toolUses?: KiroToolUse[];
}

interface KiroHistoryEntry {
	userInputMessage?: KiroUserInputMessage;
	assistantResponseMessage?: KiroAssistantResponseMessage;
}

interface KiroConversationState {
	chatTriggerType: "MANUAL";
	agentTaskType: "vibe";
	conversationId: string;
	currentMessage: { userInputMessage: KiroUserInputMessage };
	history?: KiroHistoryEntry[];
}

export interface KiroGenerateRequest {
	conversationState: KiroConversationState;
	profileArn?: string;
	agentMode: "vibe";
}

const TOOL_RESULTS_CONTENT = "Tool results provided.";
const CONTINUE_CONTENT = "Please proceed with the task.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("");
}

function imagesOf(content: string | (TextContent | ImageContent)[]): KiroImageInput[] {
	if (typeof content === "string") return [];
	return content
		.filter((c): c is ImageContent => c.type === "image")
		.map(c => ({
			format: c.mimeType.split("/")[1] || "png",
			source: { bytes: c.data },
		}));
}

function toolResultToKiro(msg: ToolResultMessage): KiroToolResult {
	return {
		toolUseId: msg.toolCallId,
		content: [{ text: textOf(msg.content) }],
		status: msg.isError ? "error" : "success",
	};
}

function assistantToKiro(msg: AssistantMessage): KiroAssistantResponseMessage | undefined {
	let thinking = "";
	let text = "";
	const toolUses: KiroToolUse[] = [];
	for (const block of msg.content) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "thinking") {
			if (block.thinking) thinking += `<thinking>${block.thinking}</thinking>\n\n`;
		} else if (block.type === "toolCall") {
			toolUses.push({ name: block.name, toolUseId: block.id, input: block.arguments ?? {} });
		}
	}
	const content = thinking + text;
	if (!content && toolUses.length === 0) return undefined;
	return toolUses.length > 0 ? { content, toolUses } : { content };
}

function toolsToKiro(tools: Tool[]): KiroToolSpecification[] {
	return tools.map(t => ({
		toolSpecification: {
			name: t.name,
			description: t.description ?? "",
			inputSchema: { json: (t.parameters ?? {}) as Record<string, unknown> },
		},
	}));
}

function hasToolCall(msg: Message | undefined): boolean {
	return msg?.role === "assistant" && msg.content.some(b => b.type === "toolCall");
}

/**
 * Enforce Kiro's (Anthropic's) pairing rule: every assistant `toolUses` entry is
 * answered by a `toolResults` block in the very next user turn, and no result
 * exists without its call. The host's own providers get this from
 * `transformMessages`; the plugin does not, and `/btw` snapshots a transcript
 * whose last tool call may still be running (or whose result was never recorded).
 * Unanswered calls get a synthetic error result, orphaned results are dropped.
 */
function pairToolCalls(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		if (msg.role === "toolResult") continue; // orphan: not claimed by the preceding assistant
		out.push(msg);
		if (msg.role !== "assistant") continue;
		const calls = msg.content.filter(b => b.type === "toolCall");
		if (calls.length === 0) continue;

		const results = new Map<string, ToolResultMessage>();
		let j = i + 1;
		for (; messages[j]?.role === "toolResult"; j++) {
			const result = messages[j] as ToolResultMessage;
			results.set(result.toolCallId, result);
		}
		for (const call of calls) {
			out.push(
				results.get(call.id) ?? {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: msg.timestamp,
				},
			);
		}
		i = j - 1;
	}
	return out;
}

/** Thinking budget prefix (pi-kiro parity), applied only to reasoning models when reasoning is requested. */
function thinkingPrefix(model: Model<Api>, options: SimpleStreamOptions): string {
	// Title generation, captions, and other utility calls set these so a
	// reasoning model does not spend the turn on thinking. `/effort` and
	// minimizeEffort still select a budget when reasoning stays on.
	if (options?.disableReasoning || options?.forceReasoningOff) return "";
	if (!model.reasoning) return "";
	const effort = options?.minimizeEffort ? "minimal" : options?.reasoning;
	if (!effort) return "";
	const custom = options?.thinkingBudgets?.[effort];
	const budget =
		typeof custom === "number" && Number.isFinite(custom) && custom > 0
			? custom
			: effort === "max"
				? 80000
				: effort === "xhigh"
					? 50000
					: effort === "high"
						? 30000
						: effort === "medium"
							? 20000
							: 10000;
	return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
}

/** Append a user turn, merging into the previous entry when it is also a user turn. */
function pushUser(history: KiroHistoryEntry[], uim: KiroUserInputMessage): void {
	const prev = history[history.length - 1]?.userInputMessage;
	if (!prev) {
		history.push({ userInputMessage: uim });
		return;
	}
	prev.content = prev.content ? `${prev.content}\n\n${uim.content}` : uim.content;
	if (uim.images) prev.images = [...(prev.images ?? []), ...uim.images];
	const results = uim.userInputMessageContext?.toolResults;
	if (results) {
		prev.userInputMessageContext = {
			...prev.userInputMessageContext,
			toolResults: [...(prev.userInputMessageContext?.toolResults ?? []), ...results],
		};
	}
}

/** Append an assistant turn, merging into the previous entry when it is also an assistant turn. */
function pushAssistant(history: KiroHistoryEntry[], arm: KiroAssistantResponseMessage): void {
	const prev = history[history.length - 1]?.assistantResponseMessage;
	if (!prev) {
		history.push({ assistantResponseMessage: arm });
		return;
	}
	prev.content = prev.content && arm.content ? `${prev.content}\n\n${arm.content}` : prev.content || arm.content;
	if (arm.toolUses) prev.toolUses = [...(prev.toolUses ?? []), ...arm.toolUses];
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the complete Kiro request body.
 *
 * The trailing user message — or the trailing assistant tool call plus its tool
 * results — becomes `currentMessage`; everything before goes into `history`.
 */
export function buildKiroRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	profileArn: string | undefined,
): KiroGenerateRequest {
	const modelId = toKiroModelId(model.id);
	const prefix = thinkingPrefix(model, options);
	const basePrompt = context.systemPrompt?.filter(Boolean).join("\n") ?? "";
	const systemPrompt = prefix && basePrompt ? `${prefix}\n${basePrompt}` : prefix || basePrompt;

	// Failed/aborted assistant turns are never replayed. Developer turns have no
	// Kiro role, so they travel as user text; dropping them hid instructions
	// from commands that inject a developer message.
	const messages = pairToolCalls(
		context.messages.filter(m => !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted"))),
	);

	// Locate the start of the current turn.
	let currentStart = messages.length - 1;
	while (currentStart > 0 && messages[currentStart]?.role === "toolResult") currentStart--;
	if (messages[currentStart]?.role === "assistant" && !hasToolCall(messages[currentStart])) currentStart++;
	if (currentStart < 0) currentStart = 0;

	const history: KiroHistoryEntry[] = [];
	let systemPending = systemPrompt.length > 0;

	for (const msg of messages.slice(0, currentStart)) {
		if (msg.role === "user" || msg.role === "developer") {
			let content = textOf(msg.content);
			if (systemPending) {
				content = `${systemPrompt}\n\n${content}`;
				systemPending = false;
			}
			const images = imagesOf(msg.content);
			pushUser(history, { content, modelId, origin: "KIRO_CLI", ...(images.length > 0 ? { images } : {}) });
		} else if (msg.role === "assistant") {
			const arm = assistantToKiro(msg);
			if (arm) pushAssistant(history, arm);
		} else if (msg.role === "toolResult") {
			const images = imagesOf(msg.content);
			pushUser(history, {
				content: TOOL_RESULTS_CONTENT,
				modelId,
				origin: "KIRO_CLI",
				...(images.length > 0 ? { images } : {}),
				userInputMessageContext: { toolResults: [toolResultToKiro(msg)] },
			});
		}
	}

	// Current turn.
	const current = messages.slice(currentStart);
	const first = current[0];
	let content = CONTINUE_CONTENT;
	let images: KiroImageInput[] = [];
	const toolResults: KiroToolResult[] = [];

	if (first?.role === "user" || first?.role === "developer") {
		content = textOf(first.content);
		images = imagesOf(first.content);
	} else {
		if (first?.role === "assistant") {
			const arm = assistantToKiro(first);
			if (arm) pushAssistant(history, arm);
		}
		for (const msg of current) {
			if (msg.role !== "toolResult") continue;
			toolResults.push(toolResultToKiro(msg));
			images.push(...imagesOf(msg.content));
		}
		if (toolResults.length > 0) content = TOOL_RESULTS_CONTENT;
	}

	// History must end with an assistant turn: fold a trailing user turn into the current one.
	const trailing = history[history.length - 1]?.userInputMessage;
	if (trailing) {
		history.pop();
		content = trailing.content ? `${trailing.content}\n\n${content}` : content;
		images = [...(trailing.images ?? []), ...images];
		toolResults.unshift(...(trailing.userInputMessageContext?.toolResults ?? []));
	}

	if (systemPending) content = `${systemPrompt}\n\n${content}`;

	const tools = context.tools && context.tools.length > 0 ? toolsToKiro(context.tools) : undefined;
	const userInputMessageContext: KiroUserInputMessageContext | undefined =
		toolResults.length > 0 || tools
			? { ...(toolResults.length > 0 ? { toolResults } : {}), ...(tools ? { tools } : {}) }
			: undefined;

	const currentMessage: KiroUserInputMessage = {
		content,
		modelId,
		origin: "KIRO_CLI",
		...(images.length > 0 ? { images } : {}),
		...(userInputMessageContext ? { userInputMessageContext } : {}),
	};

	return {
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: options?.sessionId ?? crypto.randomUUID(),
			currentMessage: { userInputMessage: currentMessage },
			...(history.length > 0 ? { history } : {}),
		},
		...(profileArn ? { profileArn } : {}),
		agentMode: "vibe",
	};
}
