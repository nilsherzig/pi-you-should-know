import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi loads exactly the packaged extension through its real extension loader", async (t) => {
	const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/you-should-know/index.ts"]);
	assert.equal(manifest.private, true, "distribution is through git, not npm publication");
	assert.equal(manifest.dependencies, undefined, "runtime Pi APIs must come from the host");
	const directory = await mkdtemp(resolve(tmpdir(), "pi-ysk-package-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [root],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0].commands.keys()], ["ysk"]);
});
