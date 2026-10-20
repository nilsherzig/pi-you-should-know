import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionForTest } from "../test-support/harness.ts";
import extension from "../extensions/you-should-know/index.ts";

const model = getBuiltinModels("anthropic")[0];
const usage = { input: 100, output: 30, cacheRead: 8000, cacheWrite: 0, totalTokens: 8130, cost: { input: 0.001, output: 0.003, cacheRead: 0.002, cacheWrite: 0, total: 0.006 } };
const response = (text = "learn: none"): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, model: model.id, provider: model.provider, usage, stopReason: "stop", timestamp: 1 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(entries: unknown[] = [], result: () => Promise<AssistantMessage> = async () => response(), debug = false) {
	let calls = 0;
	const previousDebug = process.env.PI_YSK_DEBUG;
	if (debug) process.env.PI_YSK_DEBUG = "1";
	else delete process.env.PI_YSK_DEBUG;
	let harness;
	try {
		harness = await loadExtensionForTest(extension, { context: {
			model,
			sessionManager: { getSessionId: () => "session", getBranch: () => entries } as unknown as ExtensionContext["sessionManager"],
			modelRegistry: { streamSimple: () => { calls++; return { result }; } } as unknown as ExtensionContext["modelRegistry"],
		} });
	} finally {
		if (previousDebug === undefined) delete process.env.PI_YSK_DEBUG;
		else process.env.PI_YSK_DEBUG = previousDebug;
	}
	await harness.emit("session_start", { reason: "resume" });
	const command = (args: string) => harness.command("ysk").handler(args, harness.commandContext);
	const ready = async () => {
		await harness.emit("context_with_system", { messages: [{ role: "user", content: "Task", timestamp: 1 }] });
		await harness.emit("before_provider_request", { payload: { messages: [] } });
	};
	return { harness, command, ready, get calls() { return calls; } };
}

test("manual check on a resumed session explains missing live request instead of silently returning", async () => {
	const setup_ = await setup([{ type: "message", message: { role: "user", content: "An old conversation", timestamp: 1 } }]);
	await setup_.command("check");
	assert.equal(setup_.calls, 0, "never reconstruct an uncached request from guessed settings");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /not started.*main.*request.*reload|not started.*main.*request.*load/i);
	await setup_.command("status");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /main.*request.*reload|main.*request.*load/i);
});

test("manual check announces background start, running state, and a completed negative result", async (t) => {
	let resolve!: (message: AssistantMessage) => void;
	const result = new Promise<AssistantMessage>((done) => { resolve = done; });
	t.after(() => resolve(response()));
	const setup_ = await setup([], () => result, true);
	await setup_.ready();
	await setup_.command("check");
	assert.equal(setup_.calls, 1);
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /started.*background/i);
	assert.match(setup_.harness.ui.statuses.get("you-should-know")!, /checking/i);
	await setup_.command("status");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /checking.*\d.*s/i);
	await setup_.command("check");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /already.*checking|already.*running/i);
	assert.equal(setup_.calls, 1);
	resolve(response()); await flush();
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /nothing.*found/i);
	assert.match(setup_.harness.ui.statuses.get("you-should-know")!, /nothing.*found/i);
	await setup_.command("status");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /nothing.*found.*cache read 8000/i);
});

test("completion status and usage survive reloading without pretending a new check ran", async () => {
	const original = await setup(); await original.ready(); await original.command("check"); await flush();
	const entries = original.harness.entries.map((entry) => ({ type: "custom", ...entry }));
	const resumed = await setup(entries);
	await resumed.command("status");
	assert.match(resumed.harness.ui.notifications.at(-1)!.message, /nothing.*found.*cache read 8000/i);
	assert.match(resumed.harness.ui.notifications.at(-1)!.message, /estimated cost \$0\.006000/);
	const result = original.harness.entries.find((entry) => entry.customType === "you-should-know-usage")!.data as {
		provider: string; model: string; source: string; startedAt: number; finishedAt: number; usage: typeof usage;
	};
	assert.equal(result.provider, model.provider);
	assert.equal(result.model, model.id);
	assert.equal(result.source, "manual");
	assert.ok(result.finishedAt >= result.startedAt);
	assert.deepEqual(result.usage, usage);
	await resumed.command("check");
	assert.match(resumed.harness.ui.notifications.at(-1)!.message, /not started/i);
	assert.equal(resumed.calls, 0);
});

test("disabled checks explain how to enable them", async () => {
	const setup_ = await setup(); await setup_.ready();
	await setup_.command("off"); await setup_.command("check");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /disabled.*\/ysk on/i);
	assert.equal(setup_.calls, 0);
});

test("manual cancellation is visible and a late response cannot replace it", async (t) => {
	let resolve!: (message: AssistantMessage) => void;
	const result = new Promise<AssistantMessage>((done) => { resolve = done; });
	t.after(() => resolve(response()));
	const setup_ = await setup([], () => result); await setup_.ready(); await setup_.command("check");
	await setup_.harness.emit("before_agent_start");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /cancelled.*main/i);
	resolve(response()); await flush();
	await setup_.command("status");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /cancelled/i);
	assert.doesNotMatch(setup_.harness.ui.notifications.at(-1)!.message, /nothing.*found/i);
});

test("manual checks report found suggestions and explain why an open offer prevents a new run", async () => {
	const note = "learn: Backups may overwrite the last good copy.\ntag: Heads up\nexplain:\n**Keep another copy**\nVerify the backup first.";
	const setup_ = await setup([], async () => response(note)); await setup_.ready();
	await setup_.command("check"); await flush();
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /finished.*suggestion found/i);
	await setup_.command("check");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /not started.*suggestion.*\/ysk more/i);
	assert.equal(setup_.calls, 1);
});

test("findings survive new main requests and reloads until explicitly handled, independently of debug mode", async () => {
	for (const debug of [false, true]) {
		const note = "learn: Keep a second backup.\ntag: Heads up\nexplain:\n**Separate storage**\nKeep it on a different device.";
		const original = await setup([], async () => response(note), debug); await original.ready(); await original.command("check"); await flush();
		for (let i = 0; i < 5; i++) await original.harness.emit("before_agent_start");
		await original.ready();
		assert.match(original.harness.ui.statuses.get("you-should-know")!, /Keep a second backup/);
		const entries = original.harness.entries.map((entry) => ({ type: "custom", ...entry }));
		for (const action of ["know", "dismiss", "chat", "off"]) {
			const restored = await setup(entries, undefined, debug);
			assert.match(restored.harness.ui.statuses.get("you-should-know")!, /Keep a second backup/);
			assert.equal(restored.harness.ui.widgets.has("you-should-know"), false);
			await restored.command("more");
			assert.match(JSON.stringify(restored.harness.ui.widgets.get("you-should-know")), /Separate storage/);
			await restored.command(action);
			assert.doesNotMatch(restored.harness.ui.statuses.get("you-should-know") ?? "", /Keep a second backup/);
			assert.equal(restored.harness.ui.widgets.has("you-should-know"), false);
		}
	}
});

test("invalid observer output is not reported as a successful empty result", async () => {
	const setup_ = await setup([], async () => response("Malformed response")); await setup_.ready();
	await setup_.command("check"); await flush();
	assert.equal(setup_.harness.ui.notifications.at(-1)!.type, "warning");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /finished.*invalid observer response/i);
});

test("requesting a manual check during an automatic run subscribes to its completion without another request", async (t) => {
	let resolve!: (message: AssistantMessage) => void;
	const result = new Promise<AssistantMessage>((done) => { resolve = done; });
	t.after(() => resolve(response()));
	const setup_ = await setup([], () => result); await setup_.ready();
	for (let i = 0; i < 6; i++) await setup_.harness.emit("turn_end", { message: response(), toolResults: [] });
	assert.equal(setup_.calls, 1);
	assert.equal(setup_.harness.ui.notifications.length, 0, "automatic checks should not create start popups");
	await setup_.command("check");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /already.*background.*notified/i);
	resolve(response()); await flush();
	assert.equal(setup_.calls, 1);
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /finished.*nothing.*found/i);
	const resultData = setup_.harness.entries.find((entry) => entry.customType === "you-should-know-usage")!.data as { source: string; usage: typeof usage };
	assert.equal(resultData.source, "automatic", "subscribing manually must preserve the original trigger source");
	assert.deepEqual(resultData.usage.cost, usage.cost);
});

test("debug automatic empty results update the footer without a completion popup", async () => {
	const setup_ = await setup([], undefined, true); await setup_.ready();
	for (let i = 0; i < 6; i++) await setup_.harness.emit("turn_end", { message: response(), toolResults: [] });
	await flush();
	assert.equal(setup_.harness.ui.notifications.length, 0);
	assert.match(setup_.harness.ui.statuses.get("you-should-know")!, /nothing.*found/i);
});

test("footer status stays hidden by default while manual start and completion still appear", async () => {
	const setup_ = await setup();
	assert.equal(setup_.harness.ui.statuses.get("you-should-know"), undefined);
	await setup_.ready(); await setup_.command("check"); await flush();
	assert.equal(setup_.harness.ui.statuses.get("you-should-know"), undefined);
	assert.match(setup_.harness.ui.notifications[0].message, /started.*background/i);
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /finished.*nothing.*found/i);
});

test("debug footer shows readiness only when explicitly enabled", async () => {
	const setup_ = await setup([], undefined, true);
	assert.match(setup_.harness.ui.statuses.get("you-should-know")!, /waiting for main-chat request/i);
	await setup_.ready();
	assert.match(setup_.harness.ui.statuses.get("you-should-know")!, /ready/i);
});

test("missing model is reported without making a request", async () => {
	const setup_ = await setup(); await setup_.ready();
	setup_.harness.context.model = undefined;
	await setup_.command("check");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /not started.*no model/i);
	assert.equal(setup_.calls, 0);
});

test("timeout clears running status even if the provider never reacts to abort", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let resolve!: (message: AssistantMessage) => void;
	const result = new Promise<AssistantMessage>((done) => { resolve = done; });
	t.after(() => resolve(response()));
	const setup_ = await setup([], () => result); await setup_.ready(); await setup_.command("check");
	t.mock.timers.tick(300_000);
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /cancelled.*timed out/i);
	await setup_.command("status");
	assert.match(setup_.harness.ui.notifications.at(-1)!.message, /timed out/i);
	assert.doesNotMatch(setup_.harness.ui.notifications.at(-1)!.message, /checking in background/i);
});
