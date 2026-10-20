import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionForTest } from "../test-support/harness.ts";
import extension from "../extensions/you-should-know/index.ts";

async function setup(entries: unknown[] = []) {
	const harness = await loadExtensionForTest(extension, { context: {
		sessionManager: { getBranch: () => entries } as unknown as ExtensionContext["sessionManager"],
		modelRegistry: { streamSimple: () => { throw new Error("Demo must not make a model request"); } } as unknown as ExtensionContext["modelRegistry"],
	} });
	await harness.emit("session_start");
	return { harness, command: (args: string) => harness.command("ysk").handler(args, harness.commandContext) };
}

test("demo displays and expands a normal suggestion without a model, live request, or conversation injection", async () => {
	const { harness, command } = await setup();
	await command("demo");
	const status = harness.ui.statuses.get("you-should-know")!;
	assert.match(status, /Heads up.*Demo: A backup/);
	assert.match(status, /\/ysk more/);
	assert.equal(harness.ui.widgets.has("you-should-know"), false);
	await command("more");
	assert.match(JSON.stringify(harness.ui.widgets.get("you-should-know")!.content), /not a finding about your session/);
	assert.equal(harness.entries.length, 0, "demo remains transient");
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.userMessages.length, 0);
	await command("dismiss");
	assert.equal(harness.ui.widgets.has("you-should-know"), false);
});

test("demo feedback and settings changes do not store a demo or change topic history/backoff", async () => {
	for (const action of ["know", "dismiss", "on"]) {
		const { harness, command } = await setup();
		await command("demo");
		await command(action);
		const state = harness.entries.filter((entry) => entry.customType === "you-should-know").at(-1)!.data as {
			current?: unknown; seen: string[]; known: string[]; ignored: number; skip: number;
		};
		assert.equal(state.current, undefined);
		assert.deepEqual(state.seen, []);
		assert.deepEqual(state.known, []);
		assert.equal(state.ignored, 0);
		assert.equal(state.skip, 0);
	}
});

test("demo does not overwrite a real suggestion", async () => {
	const current = { line: "An actual observation.", tag: "Heads up", explanation: "An actual explanation." };
	const { harness, command } = await setup([{ type: "custom", customType: "you-should-know", data: {
		enabled: true, seen: [current.line], known: [], ignored: 0, skip: 0, current,
	} }]);
	await command("demo");
	assert.match(harness.ui.statuses.get("you-should-know")!, /An actual observation/);
	assert.match(harness.ui.notifications.at(-1)!.message, /close the current suggestion/);
});

test("demo reports when no terminal UI is available", async () => {
	const { harness, command } = await setup();
	harness.context.mode = "print";
	await command("demo");
	assert.equal(harness.ui.widgets.size, 0);
	assert.match(harness.ui.notifications.at(-1)!.message, /requires the terminal UI/);
});
