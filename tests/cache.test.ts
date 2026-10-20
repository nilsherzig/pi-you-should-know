import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionForTest } from "../test-support/harness.ts";
import extension, { cacheWarning, observerContext } from "../extensions/you-should-know/index.ts";

const usage: Usage = { input: 200, cacheRead: 699, cacheWrite: 101, output: 42, totalTokens: 1042, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("warns below 70 percent, counts cache writes as misses, and shows all token counts", () => {
	const warning = cacheWarning(usage)!;
	assert.match(warning, /69\.9%/);
	assert.match(warning, /Input: 1000 tokens; cached: 699/);
	assert.match(warning, /output: 42 tokens/);
	assert.equal(cacheWarning({ ...usage, cacheRead: 700, cacheWrite: 100 }), undefined);
	assert.equal(cacheWarning({ ...usage, input: 0, cacheRead: 1000, cacheWrite: 0 }), undefined);
	assert.match(cacheWarning({ ...usage, input: 0, cacheRead: 0, cacheWrite: 0 })!, /0\.0%/);
});

test("subtracts the estimated observer suffix before evaluating main-chat cache hits", () => {
	// Overall hit rate is 40%, but the main chat is 80% cached.
	assert.equal(cacheWarning({ ...usage, input: 6000, cacheRead: 4000, cacheWrite: 0 }, 5000), undefined);
	assert.match(cacheWarning({ ...usage, input: 7000, cacheRead: 3000, cacheWrite: 0 }, 5000)!, /60\.0%/);
	assert.match(cacheWarning({ ...usage, input: 1000, cacheRead: 0, cacheWrite: 0 }, 5000)!, /0\.0%/);
});

test("cache reads establish a hit even when cache writes are zero or unreported", () => {
	assert.equal(cacheWarning({ ...usage, input: 100, cacheRead: 900, cacheWrite: 0 }), undefined);
	const { cacheWrite: _unreported, ...readOnlyUsage } = { ...usage, input: 100, cacheRead: 900 };
	assert.equal(cacheWarning(readOnlyUsage as Usage), undefined);
	assert.match(cacheWarning({ ...readOnlyUsage, cacheRead: 10 } as Usage)!, /cache writes: not reported/);
});

test("renders an error for low cache hit even when no topic is suggested", async () => {
	const response = { role: "assistant", content: [{ type: "text", text: "learn: none" }], usage: { ...usage, input: 39900, cacheRead: 60000, cacheWrite: 100 }, stopReason: "stop" } as AssistantMessage;
	const harness = await loadExtensionForTest(extension, { context: {
		model: { id: "test" } as ExtensionContext["model"],
		modelRegistry: { streamSimple: () => ({ result: async () => response }) } as unknown as ExtensionContext["modelRegistry"],
		sessionManager: { getSessionId: () => "main", getBranch: () => [] } as unknown as ExtensionContext["sessionManager"],
	} });
	await harness.emit("session_start");
	await harness.emit("context_with_system", { messages: [{ role: "user", content: "test", timestamp: 0 }] });
	await harness.emit("before_provider_request", { payload: { messages: [] } });
	await harness.command("ysk").handler("check", harness.commandContext);
	const errors = harness.ui.notifications.filter((notification) => notification.type === "error");
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /Input: 100000 tokens; cached: 60000/);
	assert.match(errors[0].message, /output: 42 tokens/);
});

test("system/tool declarations, thinking signatures and images are preserved, not serialized or replaced", () => {
	const messages: Message[] = [
		{ role: "system", content: "main prompt", timestamp: 0, toolsAdded: [{ name: "test", description: "test", parameters: {} }] },
		{ role: "user", content: [{ type: "image", data: "test-image", mimeType: "image/png" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "thinking", thinking: "main thinking", thinkingSignature: "provider-signature" }], timestamp: 2 } as AssistantMessage,
	];
	const original = structuredClone(messages);
	const context = observerContext(messages, { seen: ["previous"], known: ["understood"] });
	assert.equal(context.systemPrompt, undefined);
	assert.deepEqual(context.messages.slice(0, -1), original);
	assert.deepEqual(messages, original);
	assert.match(String(context.messages.at(-1)?.content), /previous/);
});
