import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AssistantMessage, Context, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionForTest } from "../test-support/harness.ts";
import extension, { backoff, inheritMainRequest, observerContext, parseSuggestion } from "../extensions/you-should-know/index.ts";

const note = "learn: The new backup job may overwrite the only working snapshot.\ntag: Heads up\nexplain:\n**Keep a working backup**\nVerify a second copy before replacing the snapshot.";
const usage = { input: 100, output: 30, cacheRead: 8000, cacheWrite: 100, totalTokens: 8230, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = getBuiltinModels("anthropic").find((model) => model.api === "anthropic-messages")!;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const reply = (text = "learn: none"): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, model: model.id, provider: model.provider, usage, stopReason: "stop", timestamp: 2 });
const history = { seen: [], known: [] };
const textOf = (message: Message) => {
	assert.ok(Array.isArray(message.content));
	const block = message.content[0];
	assert.equal(block.type, "text");
	return (block as { text: string }).text;
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(result: () => Promise<AssistantMessage> = async () => reply(), entries: unknown[] = [], registryOverrides: Record<string, unknown> = {}) {
	const calls: { context: Context; options: SimpleStreamOptions }[] = [];
	const registry = { streamSimple: (_model: unknown, context: Context, options: SimpleStreamOptions) => {
		calls.push({ context, options });
		return { result };
	}, ...registryOverrides };
	const harness = await loadExtensionForTest(extension, { context: {
		model, modelRegistry: registry as unknown as ExtensionContext["modelRegistry"],
		sessionManager: { getSessionId: () => "test-session", getBranch: () => entries } as unknown as ExtensionContext["sessionManager"],
	}, api: { getThinkingLevel: () => "high" } });
	await harness.emit("session_start");
	await harness.emit("context_with_system", { messages: [user("Protect my backups.")] });
	await harness.emit("before_provider_request", { payload: { messages: [{ role: "user", content: [{ type: "text", text: "Protect my backups." }] }], max_tokens: 32000, thinking: { type: "enabled", budget_tokens: 16000 } } });
	const turn = () => harness.emit("turn_end", { message: reply(), toolResults: [] });
	const command = (action: string) => harness.command("ysk").handler(action, harness.commandContext);
	return { harness, calls, turn, command };
}

test("accepts complete notes and rejects none or malformed/incomplete output", () => {
	assert.equal(parseSuggestion(note)?.tag, "Heads up");
	for (const text of ["learn: none", "learn: none.", "not a note", "learn: Hi\ntag: other\nexplain: no", "learn: Hi\ntag: Heads up\nexplain:"]) assert.equal(parseSuggestion(text), undefined);
});

test("conversation and tool results remain a stable cache prefix as history grows", () => {
	const tool: Message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "x".repeat(100_000) }], isError: false, timestamp: 3 };
	const first = observerContext([user("one"), tool], history);
	const next = observerContext([user("one"), tool, user("two")], { seen: ["New topic"], known: ["Old topic"] });
	assert.equal(next.systemPrompt, first.systemPrompt);
	assert.deepEqual(next.messages.slice(0, 2), first.messages.slice(0, -1));
	assert.match(textOf(first.messages[1]), /x{100000}/);
	assert.equal(first.tools, undefined);
	assert.match(String(next.messages.at(-1)?.content), /New topic/);
});

test("real Anthropic conversion preserves main system, tools, reasoning, budget, and cache boundary", async () => {
	const initial: Message[] = [
		{ role: "system", content: "Original main system instructions", timestamp: 0, toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] },
		user("first"), reply("Working."), user("second"),
	];
	async function capture(context: Context, main?: unknown) {
		let captured: any;
		const response = await streamSimple(model, context, {
			apiKey: "test-key-not-a-secret", cacheRetention: "long", sessionId: "stable-test-session", reasoning: "high", maxTokens: 32000,
			onPayload: (payload) => {
				if (main) inheritMainRequest(payload, main);
				captured = structuredClone(payload);
				throw new Error("Stop before network request");
			},
		}).result();
		assert.ok(captured, response.errorMessage);
		return captured;
	}
	const main = await capture({ messages: initial });
	const observer = await capture(observerContext([...initial, reply("Finished."), ...Array.from({ length: 35 }, (_, i) => user(`new ${i}`))], history), main);
	assert.deepEqual(observer.system, main.system);
	assert.deepEqual(observer.tools, main.tools);
	assert.deepEqual(observer.thinking, main.thinking);
	assert.equal(observer.max_tokens, main.max_tokens);
	assert.deepEqual(observer.messages.slice(0, main.messages.length), main.messages);
	const blocks = observer.messages.flatMap((message: any) => message.content);
	assert.ok([...observer.system, ...observer.tools, ...blocks].filter((block) => block.cache_control).length <= 4);
	assert.match(blocks.at(-1).text, /Previously suggested topics/);
});

test("real OpenAI conversion reuses the main request prefix, cache key, and reasoning", async () => {
	const openai = getBuiltinModels("openai").find((model) => model.api === "openai-responses" && model.id.includes("gpt-5"))!;
	assert.ok(openai);
	const initial: Message[] = [{ role: "system", content: "Original main instructions", timestamp: 0 }, user("Do the task.")];
	async function capture(context: Context, main?: unknown) {
		let captured: any;
		const response = await streamSimple(openai, context, {
			apiKey: "test-key-not-a-secret", sessionId: "main-session", reasoning: "high", maxTokens: 32000,
			onPayload: (payload) => {
				if (main) inheritMainRequest(payload, main);
				captured = structuredClone(payload);
				throw new Error("Stop before network request");
			},
		}).result();
		assert.ok(captured, response.errorMessage);
		return captured;
	}
	const main = await capture({ messages: initial });
	const observer = await capture(observerContext([...initial, user("Additional context")], history), main);
	assert.deepEqual(observer.input.slice(0, main.input.length), main.input);
	assert.deepEqual(observer.reasoning, main.reasoning);
	assert.equal(observer.prompt_cache_key, main.prompt_cache_key);
	assert.equal(observer.max_output_tokens, main.max_output_tokens);
});


test("inherits OpenAI cache key, reasoning, and output budget without modifying input", () => {
	const main = { input: [{ role: "user", content: "prefix" }], prompt_cache_key: "main-session", reasoning: { effort: "high" }, max_output_tokens: 32000, instructions: "Original system" };
	const request = { input: [...main.input, { role: "user", content: "observer" }], prompt_cache_key: "wrong", reasoning: { effort: "low" }, max_output_tokens: 1024, temperature: 0 };
	inheritMainRequest(request, main);
	assert.deepEqual(request, { ...main, input: [...main.input, { role: "user", content: "observer" }] });
});

test("blocks changed main transcript prefixes before the provider request is sent", () => {
	assert.throws(() => inheritMainRequest({ messages: [{ role: "user", content: "rewritten" }] }, { messages: [{ role: "user", content: "original" }] }), /blocked/);
});

test("does not check providers whose custom stream rewrites the captured request", async () => {
	const { harness, calls, turn, command } = await setup(async () => reply(note), [], {
		getRegisteredProviderConfig: () => ({ streamSimple: () => undefined }),
	});
	for (let i = 0; i < 6; i++) await turn();
	await command("check");
	assert.equal(calls.length, 0);
	assert.match(harness.ui.notifications.at(-1)!.message, /custom provider/);
});

test("xAI OAuth checks reuse the sanitized main request as their cache prefix", async () => {
	// Captured from pi-ai's OpenAI Responses converter and pi-grok 0.12.1's
	// sanitizePayload for grok-4.7. The fixture is what xai-oauth actually sends:
	// system text moved to instructions, rejected fields removed, reasoning kept.
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/xai-oauth-request.json", import.meta.url), "utf8")) as {
		main: Record<string, unknown> & { input: unknown[] };
		observer: Record<string, unknown> & { input: unknown[] };
	};
	const grok = { ...model, provider: "xai-oauth", id: "grok-4.7", api: "openai-responses" as const };
	const transcript: Message[] = [
		{ role: "system", content: "Original main instructions", timestamp: 0 },
		user("Do the task."),
	];
	const { harness, calls, command } = await setup();
	let dispatched: unknown;
	harness.context.model = grok;
	harness.context.modelRegistry.getRegisteredProviderConfig = ((provider: string) =>
		provider === "xai-oauth" ? { streamSimple: () => undefined } : undefined) as ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"];
	harness.context.modelRegistry.streamSimple = ((_model: unknown, context: Context, options: SimpleStreamOptions) => {
		calls.push({ context, options });
		return { result: async () => {
			const request = structuredClone(fixture.observer);
			options.onPayload?.(request, grok);
			dispatched = request;
			return reply();
		} };
	}) as ExtensionContext["modelRegistry"]["streamSimple"];
	await harness.emit("context_with_system", { messages: transcript });
	await harness.emit("before_provider_request", { payload: fixture.main });
	await command("check");
	await flush();
	assert.equal(calls.length, 1);
	const sent = dispatched as typeof fixture.observer;
	assert.deepEqual(sent.input.slice(0, fixture.main.input.length), fixture.main.input);
	assert.ok(sent.input.length > fixture.main.input.length);
	const { input: _mainInput, ...mainSettings } = fixture.main;
	const { input: _sentInput, ...sentSettings } = sent;
	assert.deepEqual(sentSettings, mainSettings);
	assert.equal(sent.prompt_cache_retention, undefined);
	assert.equal(sent.reasoning && (sent.reasoning as { summary?: unknown }).summary, undefined);
	assert.match(JSON.stringify(sent.input.at(-1)), /Previously suggested topics/);
});

test("checks every six steps without changing main context; reports real usage", async () => {
	const { harness, calls, turn, command } = await setup(async () => reply(note));
	for (let i = 0; i < 5; i++) await turn();
	assert.equal(calls.length, 0);
	await turn(); await flush();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].options.reasoning, "high");
	assert.equal(calls[0].options.maxTokens, undefined);
	assert.equal(calls[0].options.sessionId, "test-session");
	assert.match(harness.ui.statuses.get("you-should-know")!, /backup/);
	assert.equal(harness.ui.widgets.has("you-should-know"), false);
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.userMessages.length, 0);
	assert.ok(!harness.eventHandlers.has("context"));
	await command("status");
	assert.match(harness.ui.notifications.at(-1)!.message, /cache read 8000, write 100/);
	await command("more");
	assert.match(JSON.stringify(harness.ui.widgets.get("you-should-know")), /Keep a working backup/);
});

test("repeated checks reuse session identity and keep topic history after the transcript", async () => {
	const { calls, command } = await setup();
	await command("check"); await command("check");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].options.sessionId, calls[1].options.sessionId);
	assert.deepEqual(calls[0].context, calls[1].context);
});

test("understood topics persist on the branch; reload restores off state", async () => {
	const { harness, command } = await setup(async () => reply(note));
	await command("check"); await command("know");
	const saved = harness.entries.filter((entry) => entry.customType === "you-should-know").at(-1)!;
	assert.deepEqual((saved.data as { known: string[] }).known, [parseSuggestion(note)!.line]);
	await command("off");
	const off = harness.entries.filter((entry) => entry.customType === "you-should-know").at(-1)!;
	const restored = await setup(async () => reply(), [{ type: "custom", ...off }]);
	await restored.command("check");
	assert.equal(restored.calls.length, 0);
});

test("suppresses repeated topics even when the model suggests them again", async () => {
	const { harness, command } = await setup(async () => reply(note));
	await command("check"); await command("know"); await command("check");
	assert.equal(harness.ui.widgets.has("you-should-know"), false);
	await command("status");
	assert.match(harness.ui.notifications.at(-1)!.message, /duplicate/);
});

test("offers remain in the footer until acknowledged; dismissal backoff is bounded", async () => {
	const { harness, command } = await setup(async () => reply(note));
	await command("check");
	for (let i = 0; i < 6; i++) await harness.emit("before_agent_start");
	assert.match(harness.ui.statuses.get("you-should-know")!, /backup/);
	await command("dismiss");
	assert.equal(harness.ui.statuses.get("you-should-know"), undefined);
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoff), [0, 0, 1, 2, 4, 8, 16, 16]);
});

test("only explicitly discussing a note puts it in the editor; never overwrites a draft", async () => {
	const { harness, command } = await setup(async () => reply(note));
	await command("check");
	harness.context.ui.setEditorText("my draft");
	await command("chat");
	assert.equal(harness.ui.editorText, "my draft");
	harness.context.ui.setEditorText("");
	await command("chat");
	assert.match(harness.ui.editorText, /Let's discuss this observer note/);
	assert.equal(harness.userMessages.length, 0);
});

test("single flight and session shutdown discard late responses", async () => {
	let resolve!: (message: AssistantMessage) => void;
	const deferred = new Promise<AssistantMessage>((done) => { resolve = done; });
	const { harness, calls, command } = await setup(() => deferred);
	const checking = command("check");
	await command("check");
	assert.equal(calls.length, 1);
	await harness.emit("session_shutdown");
	assert.ok(calls[0].options.signal?.aborted);
	const cancelledEntries = structuredClone(harness.entries);
	assert.match((cancelledEntries.at(-1)!.data as { outcome: string }).outcome, /cancelled/);
	resolve(reply(note)); await checking; await flush();
	assert.equal(harness.ui.widgets.has("you-should-know"), false);
	assert.deepEqual(harness.entries, cancelledEntries, "late response must not overwrite the recorded cancellation");
});

test("automatic checks and manual commands return while the observer is still running", async () => {
	let resolve!: (message: AssistantMessage) => void;
	const deferred = new Promise<AssistantMessage>((done) => { resolve = done; });
	const { harness, calls, turn, command } = await setup(() => deferred);
	for (let i = 0; i < 6; i++) await turn();
	assert.equal(calls.length, 1);
	assert.equal(harness.entries.length, 0, "observer is still pending after turn_end returns");
	await turn();
	await command("check");
	assert.equal(calls.length, 1, "single flight while the main run continues");
	await command("status");
	assert.match(harness.ui.notifications.at(-1)!.message, /checking/);
	resolve(reply()); await flush();
	assert.ok(harness.entries.length > 0);
});

test("observer failures do not affect main work and allow a later retry", async () => {
	const { calls, command, harness } = await setup(async () => { throw new Error("offline"); });
	await command("check"); await command("check");
	assert.equal(calls.length, 2);
	await command("status");
	assert.match(harness.ui.notifications.at(-1)!.message, /offline/);
});

test("automatic checks are disabled outside the terminal UI", async () => {
	const { harness, calls, turn } = await setup();
	harness.context.mode = "print";
	for (let i = 0; i < 6; i++) await turn();
	assert.equal(calls.length, 0);
});
