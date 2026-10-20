import { readFileSync } from "node:fs";
import type { Context, Message, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = "you-should-know";
const PROMPT = readFileSync(new URL("./observer-prompt.md", import.meta.url), "utf8");
export interface Suggestion { line: string; tag: "Heads up" | "You should know"; explanation: string }
interface State {
	enabled: boolean;
	seen: string[];
	known: string[];
	ignored: number;
	skip: number;
	current?: Suggestion & { demo?: true };
}
interface CheckIdentity {
	provider: string;
	model: string;
	source: "manual" | "automatic";
}
interface CheckResult extends Partial<CheckIdentity> {
	outcome: string;
	usage?: Usage;
	observerTokens?: number;
	startedAt?: number;
	finishedAt?: number;
}
interface ActiveCheck {
	identity: CheckIdentity;
	controller: AbortController;
	manual: boolean;
	startedAt: number;
	timeout: ReturnType<typeof setTimeout>;
}
const outcomeText = (outcome: string) => ({
	none: "nothing worth flagging found",
	suggested: "new suggestion found; use /ysk more",
	duplicate: "duplicate topic; no new suggestion",
	"invalid response": "invalid observer response; no usable result",
}[outcome] ?? outcome);
const elapsed = (startedAt: number, finishedAt = Date.now()) => `${Math.max(0, (finishedAt - startedAt) / 1000).toFixed(1)}s`;

const fresh = (): State => ({ enabled: true, seen: [], known: [], ignored: 0, skip: 0 });
const topicKey = (line: string) => line.toLowerCase().replace(/[.\s]+$/g, "");
export const backoff = (ignored: number) => ignored <= 2 ? 0 : Math.min(16, 2 ** (ignored - 3));

export function cacheWarning(usage: Usage, observerTokens = 0): string | undefined {
	// Pi reports uncached input, cache reads, and cache writes as disjoint counts.
	const cached = usage.cacheRead ?? 0;
	const input = (usage.input ?? 0) + cached + (usage.cacheWrite ?? 0);
	const mainInput = Math.max(cached, input - observerTokens, 0);
	const hitRate = mainInput > 0 ? cached / mainInput : 0;
	if (hitRate >= 0.7) return;
	return `You should know: LOW MAIN-CHAT CACHE HIT RATE ${(hitRate * 100).toFixed(1)}% (minimum 70%, estimated). Input: ${input} tokens; cached: ${cached}; observer prompt: ~${observerTokens}; main chat: ~${mainInput}; uncached: ${usage.input ?? 0}; cache writes: ${usage.cacheWrite ?? "not reported"}; output: ${usage.output ?? 0} tokens.`;
}

export function parseSuggestion(text: string): Suggestion | undefined {
	if (/^learn:\s*none[.!]?\s*$/i.test(text.trim())) return;
	const match = /^learn:\s*([^\n]+)\s*\ntag:\s*(You should know|Heads up)\s*\nexplain:\s*([\s\S]+)$/i.exec(text.trim());
	if (!match || match[1].length > 240 || match[3].length > 8000) return;
	return { line: match[1].trim(), tag: match[2].toLowerCase() === "heads up" ? "Heads up" : "You should know", explanation: match[3].trim() };
}

// Do not replace system messages, tool declarations, images, or thinking blocks.
export function observerContext(messages: Message[], state: Pick<State, "seen" | "known">): Context {
	return { messages: [
		...messages,
		{ role: "user", timestamp: 0, content: `${PROMPT}\n\nPi observer request: Do not continue the main task. Do not call tools; tool execution is unavailable for this side request. The following actual topic history overrides the empty history in the template.\nPreviously suggested topics:\n${JSON.stringify(state.seen)}\nAlready understood topics:\n${JSON.stringify(state.known)}\nReturn learn: none unless one consequential, overlooked topic clears the bar.` },
	] };
}

type Payload = Record<string, any>;
function isPrefix(original: any, extended: any): boolean {
	if (Array.isArray(original)) return Array.isArray(extended) && original.length <= extended.length && original.every((value, index) => isPrefix(value, extended[index]));
	if (original && typeof original === "object") return !!extended && typeof extended === "object" && Object.keys(original).every((key) => isPrefix(original[key], extended[key]));
	return original === extended;
}
// Use the main request's actual generation/cache settings, including provider-specific
// reasoning parameters and token budget. Retain its Anthropic cache boundary as well
// as the SDK's final marker: system + tools + main boundary + observer = at most four.
export function inheritMainRequest(payload: unknown, mainPayload: unknown): void {
	if (!payload || !mainPayload || typeof payload !== "object" || typeof mainPayload !== "object") return;
	const request = payload as Payload;
	const main = mainPayload as Payload;
	const conversationKeys = new Set(["messages", "input", "contents"]);
	for (const key of Object.keys(request)) {
		if (!conversationKeys.has(key) && !(key in main)) delete request[key];
	}
	for (const [key, value] of Object.entries(main)) {
		if (!conversationKeys.has(key)) request[key] = structuredClone(value);
	}
	if (Array.isArray(main.messages) && Array.isArray(request.messages)) {
		for (let i = 0; i < main.messages.length; i++) {
			const oldBlocks = main.messages[i].content;
			let newBlocks = request.messages[i]?.content;
			// The SDK represents an unmarked text-only message as a string, but
			// promotes it to blocks when adding a cache marker. Preserve that form.
			if (Array.isArray(oldBlocks) && typeof newBlocks === "string") {
				newBlocks = [{ type: "text", text: newBlocks }];
				request.messages[i].content = newBlocks;
			}
			if (!Array.isArray(oldBlocks) || !Array.isArray(newBlocks)) continue;
			for (let j = 0; j < oldBlocks.length; j++) {
				const { cache_control, ...oldBlock } = oldBlocks[j];
				const { cache_control: _marker, ...newBlock } = newBlocks[j] ?? {};
				if (cache_control && JSON.stringify(oldBlock) === JSON.stringify(newBlock)) newBlocks[j].cache_control = structuredClone(cache_control);
			}
		}
	}
	for (const key of conversationKeys) {
		if (key in main && !isPrefix(main[key], request[key])) throw new Error(`Observer request blocked: ${key} no longer matches the main request prefix.`);
	}
}

export default function youShouldKnow(pi: ExtensionAPI) {
	const debug = process.env.PI_YSK_DEBUG === "1";
	let state = fresh();
	let transcript: Message[] = [];
	let steps = 0;
	let generation = 0;
	let pending: ActiveCheck | undefined;
	let mainPayload: unknown;
	let lastResult: CheckResult | undefined;
	const save = () => pi.appendEntry(KEY, structuredClone({ ...state, current: state.current?.demo ? undefined : state.current }));
	const unavailable = (ctx: ExtensionContext): string | undefined => {
		if (!state.enabled) return "checks are disabled; use /ysk on";
		if (state.current) return "a suggestion is already open; use /ysk more, /ysk know, or /ysk dismiss";
		if (!ctx.model) return "no model is selected";
		if (!transcript.length || !mainPayload) return "no live main-chat request observed since session load/reload. Send a normal chat message first, then use /ysk check; the exact request settings are needed to preserve caching";
	};
	const summary = () => {
		if (pending) return `checking in background (${elapsed(pending.startedAt)} elapsed)`;
		if (!lastResult) return "no completed check in this session";
		const duration = lastResult.startedAt !== undefined && lastResult.finishedAt !== undefined
			? ` (${elapsed(lastResult.startedAt, lastResult.finishedAt)})` : "";
		return `${outcomeText(lastResult.outcome)}${duration}`;
	};
	const updateStatus = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (state.current) {
			ctx.ui.setStatus(KEY, `YSK · ${state.current.tag}: ${state.current.line} · /ysk more · /ysk know · /ysk dismiss`);
			return;
		}
		ctx.ui.setStatus(KEY, debug ? `YSK: ${!state.enabled ? "disabled" : pending || lastResult ? summary() : transcript.length && mainPayload ? "ready" : "waiting for main-chat request"}` : undefined);
	};
	const recordResult = (ctx: ExtensionContext, result: CheckResult, manual: boolean) => {
		lastResult = result;
		pi.appendEntry(`${KEY}-usage`, structuredClone(result));
		updateStatus(ctx);
		if (manual || result.outcome.startsWith("error:")) ctx.ui.notify(`You should know: check finished — ${summary()}.`, result.outcome.startsWith("error:") ? "error" : result.outcome === "invalid response" ? "warning" : "info");
	};
	const cancel = (ctx: ExtensionContext, reason: string, notify = true) => {
		generation++;
		const active = pending;
		if (!active) return;
		pending = undefined;
		clearTimeout(active.timeout);
		active.controller.abort();
		recordResult(ctx, { ...active.identity, outcome: `cancelled: ${reason}`, startedAt: active.startedAt, finishedAt: Date.now() }, active.manual && notify);
	};
	const render = (ctx: ExtensionContext, expanded = false) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(KEY, state.current && expanded ? [
			`${state.current.tag} · ${state.current.line}`,
			...state.current.explanation.split("\n"),
			"/ysk more · /ysk know · /ysk dismiss · /ysk chat · /ysk off",
		] : undefined, { placement: "aboveEditor" });
		updateStatus(ctx);
	};
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		cancel(ctx, "session changed", false); state = fresh(); transcript = []; steps = 0; mainPayload = undefined;
		lastResult = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === KEY) {
				const data = entry.data as State;
				if (data && typeof data.enabled === "boolean" && Array.isArray(data.seen) && Array.isArray(data.known)) state = structuredClone(data);
			} else if (entry.type === "custom" && entry.customType === `${KEY}-usage`) {
				const result = entry.data as CheckResult;
				if (result && typeof result.outcome === "string") lastResult = structuredClone(result);
			}
		}
		render(ctx); updateStatus(ctx);
	};
	const check = async (ctx: ExtensionContext, manual = false) => {
		if (pending) {
			if (manual) {
				pending.manual = true;
				ctx.ui.notify(`You should know: already checking in background (${elapsed(pending.startedAt)} elapsed). You will be notified when it finishes.`, "info");
			}
			return;
		}
		const reason = unavailable(ctx);
		if (reason || !ctx.model) {
			if (manual) ctx.ui.notify(`You should know: check not started — ${reason}.`, "warning");
			updateStatus(ctx); return;
		}
		const controller = new AbortController();
		const active: ActiveCheck = {
			identity: { provider: ctx.model.provider, model: ctx.model.id, source: manual ? "manual" : "automatic" },
			controller, manual, startedAt: Date.now(),
			timeout: setTimeout(() => { if (pending === active) cancel(ctx, "timed out after five minutes"); }, 300_000),
		};
		pending = active;
		const version = generation;
		const context = observerContext(transcript, state);
		const observerTokens = estimateTokens(context.messages.at(-1)!);
		const requestPrefix = mainPayload;
		const thinking = pi.getThinkingLevel();
		const finish = (result: CheckResult) => {
			if (pending !== active || version !== generation) return;
			pending = undefined; clearTimeout(active.timeout);
			recordResult(ctx, { ...result, ...active.identity, startedAt: active.startedAt, finishedAt: Date.now() }, active.manual);
		};
		updateStatus(ctx);
		if (manual) ctx.ui.notify("You should know: check started in background. Use /ysk status for progress.", "info");
		try {
			const response = await ctx.modelRegistry.streamSimple(ctx.model, context, {
				signal: controller.signal,
				reasoning: thinking === "off" ? undefined : thinking,
				sessionId: ctx.sessionManager.getSessionId(),
				onPayload: (payload) => { inheritMainRequest(payload, requestPrefix); },
			}).result();
			if (version !== generation || controller.signal.aborted) return;
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				finish({ outcome: response.stopReason === "aborted" ? "cancelled by provider" : `error: ${response.errorMessage || response.stopReason}`, usage: response.usage, observerTokens });
				return;
			}
			const warning = cacheWarning(response.usage, observerTokens);
			if (warning) ctx.ui.notify(warning, "error");
			const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			const suggestion = parseSuggestion(text);
			let outcome = suggestion ? "suggested" : /^learn:\s*none[.!]?\s*$/i.test(text.trim()) ? "none" : "invalid response";
			if (suggestion && ![...state.seen, ...state.known].some((line) => topicKey(line) === topicKey(suggestion.line))) {
				state.current = suggestion;
				state.seen = [...state.seen, suggestion.line].slice(-50);
			} else if (suggestion) outcome = "duplicate";
			save(); render(ctx);
			finish({ usage: response.usage, observerTokens, outcome });
		} catch (error) {
			finish({ outcome: controller.signal.aborted ? "cancelled by provider" : `error: ${String(error)}` });
		} finally {
			clearTimeout(active.timeout);
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_before_tree", (_event, ctx) => cancel(ctx, "tree navigation"));
	pi.on("session_shutdown", (_event, ctx) => cancel(ctx, "session shutdown", false));
	pi.on("session_compact", (_event, ctx) => { cancel(ctx, "compaction"); transcript = []; mainPayload = undefined; updateStatus(ctx); });
	pi.on("model_select", (_event, ctx) => { cancel(ctx, "model changed"); transcript = []; mainPayload = undefined; updateStatus(ctx); });
	pi.on("thinking_level_select", (_event, ctx) => cancel(ctx, "reasoning level changed"));
	pi.on("before_provider_request", (event, ctx) => { mainPayload = structuredClone(event.payload); updateStatus(ctx); });
	pi.on("agent_settled", (event, ctx) => { if (event.aborted) cancel(ctx, "main run aborted"); });
	pi.on("context_with_system", (event, ctx) => { transcript = structuredClone(convertToLlm(event.messages)); updateStatus(ctx); });
	pi.on("before_agent_start", (_event, ctx) => cancel(ctx, "new main-chat run started"));
	pi.on("turn_end", (event, ctx) => {
		transcript = [...transcript, ...convertToLlm([event.message, ...event.toolResults])];
		if (++steps % 6 !== 0 || ctx.mode !== "tui" || state.current || !state.enabled) return;
		if (state.skip > 0) { state.skip--; save(); return; }
		// Deliberately do not await: the main run continues while the observer works.
		void check(ctx);
	});
	pi.registerCommand("ysk", {
		description: "You should know: demo, more, know, dismiss, chat, check, on, off, status",
		handler: async (args, ctx) => {
			const action = args.trim() || "more";
			if (action === "demo") {
				if (ctx.mode !== "tui") { ctx.ui.notify("You should know: the demo requires the terminal UI.", "warning"); return; }
				if (pending || (state.current && !state.current.demo)) {
					ctx.ui.notify("You should know: wait for the running check or close the current suggestion before showing the demo.", "info"); return;
				}
				state.current = {
					demo: true,
					tag: "Heads up",
					line: "Demo: A backup on the same disk cannot protect your files if that disk fails.",
					explanation: "**Demo: Keep a separate backup**\n\nThis is a demo, not a finding about your session.\n\n- A second folder on the same disk can protect against accidentally editing a file.\n- If the disk fails, both the original and that backup can disappear together.\n- Keep another copy on a separate device or a remote backup service, and check that you can restore it.",
				};
				render(ctx);
				ctx.ui.notify("You should know: demo shown. Use /ysk more to expand or /ysk dismiss to close. No model request was made.", "info");
				return;
			}
			if (action === "status") {
				const reason = unavailable(ctx);
				const usage = lastResult?.usage;
				const tokens = usage ? `; last completed usage: cache read ${usage.cacheRead ?? 0}, write ${usage.cacheWrite ?? "not reported"}; input ${(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)}, output ${usage.output ?? 0}` : "";
				const cost = usage?.cost?.total !== undefined ? `; estimated cost $${usage.cost.total.toFixed(6)}` : "";
				const model = lastResult?.model ? `; ${lastResult.provider}/${lastResult.model} (${lastResult.source})` : "";
				const when = lastResult?.finishedAt !== undefined ? `; last finished ${new Date(lastResult.finishedAt).toISOString()}` : "";
				ctx.ui.notify(`${state.enabled ? "on" : "off"}; ${summary()}${tokens}${cost}${model}${when}${!pending && reason ? `; not ready: ${reason}` : ""}`, "info"); return;
			}
			if (action === "check") { void check(ctx, true); return; }
			if (action === "off" || action === "on") {
				cancel(ctx, "checks disabled"); state.enabled = action === "on";
				if (!state.enabled) state.current = undefined;
				save(); render(ctx); updateStatus(ctx); return;
			}
			if (!state.current) { ctx.ui.notify("No suggestion. Use /ysk status or /ysk check.", "info"); return; }
			if (action === "more") { render(ctx, true); return; }
			if (!["know", "dismiss", "chat"].includes(action)) { ctx.ui.notify("Use /ysk demo|more|know|dismiss|chat|check|on|off|status", "warning"); return; }
			if (action === "chat") {
				if (ctx.ui.getEditorText().trim()) { ctx.ui.notify("Send or clear your draft first.", "warning"); return; }
				ctx.ui.setEditorText(`Let's discuss this observer note:\n\n${state.current.line}\n\n${state.current.explanation}`);
			}
			if (!state.current.demo) {
				if (action === "know") state.known = [...state.known, state.current.line].slice(-50);
				state.ignored = action === "dismiss" ? state.ignored + 1 : 0;
				state.skip = backoff(state.ignored);
			}
			state.current = undefined; save(); render(ctx);
		},
	});
}
