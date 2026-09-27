import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isUnpublishedForkPackage } from "./registry-packages.mjs";
import { unpublishedBundledWorkspaces } from "./unpublished-bundled-workspaces.mjs";

const ENGINE = "@code-yeongyu/senpi-fixture-engine";
const PROTOCOL = "@code-yeongyu/senpi-fixture-protocol";

const workspaces = [
	{ source: "packages/senpi-codemode", packageName: "@code-yeongyu/senpi-codemode" },
	{ source: "packages/ai", packageName: "@earendil-works/pi-ai" },
	{ source: "packages/fixture-protocol", packageName: PROTOCOL },
	{ source: "packages/fixture-engine", packageName: ENGINE },
];

let repoRoot;

function writeFile(relativePath, content) {
	const path = join(repoRoot, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
}

function givenRepo({ codingAgentDependencies = {}, aiDependencies = {} } = {}) {
	repoRoot = mkdtempSync(join(tmpdir(), "senpi-unpublished-"));
	writeFile("packages/coding-agent/package.json", { name: "@code-yeongyu/senpi", dependencies: codingAgentDependencies });
	writeFile("packages/senpi-codemode/package.json", { name: "@code-yeongyu/senpi-codemode" });
	writeFile("packages/ai/package.json", { name: "@earendil-works/pi-ai", dependencies: aiDependencies });
	writeFile("packages/fixture-protocol/package.json", { name: PROTOCOL, private: true });
	writeFile("packages/fixture-engine/package.json", { name: ENGINE, private: true, dependencies: { [PROTOCOL]: "1.0.0" } });
	writeFile("packages/coding-agent/dist/bundle/cli.js", 'import { stream } from "@earendil-works/pi-ai";\n');
}

afterEach(() => {
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

describe("isUnpublishedForkPackage", () => {
	it("marks fork-scope packages outside the publish set, and only those", () => {
		assert.equal(isUnpublishedForkPackage(ENGINE), true);
		assert.equal(isUnpublishedForkPackage("@code-yeongyu/senpi-codemode"), false);
		assert.equal(isUnpublishedForkPackage("@code-yeongyu/senpi-ai"), false);
		assert.equal(isUnpublishedForkPackage("@earendil-works/chord"), false);
	});
});

describe("unpublishedBundledWorkspaces (senpi#2141)", () => {
	it("leaves out the never-published workspaces nothing shipped reaches, even when they declare each other", () => {
		// given: the engine declares the protocol, but neither is imported or declared by anything shipped
		givenRepo();

		// when
		const excluded = unpublishedBundledWorkspaces(repoRoot, workspaces);

		// then
		assert.deepEqual([...excluded].sort(), [ENGINE, PROTOCOL]);
	});

	it("fails the release when the built coding-agent dist imports a never-published package", () => {
		// given: the bundle keeps the engine external, as a native sidecar would be
		givenRepo();
		writeFile("packages/coding-agent/dist/bundle/fixture.js", `const engine = await import("${ENGINE}");\n`);

		// when / then
		assert.throws(
			() => unpublishedBundledWorkspaces(repoRoot, workspaces),
			/never published: @code-yeongyu\/senpi-fixture-engine \(imported by packages\/coding-agent\/dist\/bundle\/fixture\.js\)/,
		);
	});

	it("fails the release when a shipped manifest declares a never-published package", () => {
		// given: a published bundled workspace and the CLI manifest each declare one
		givenRepo({ codingAgentDependencies: { [ENGINE]: "1.0.0" }, aiDependencies: { [PROTOCOL]: "1.0.0" } });

		// when / then
		assert.throws(() => unpublishedBundledWorkspaces(repoRoot, workspaces), (error) => {
			assert.match(error.message, /senpi-fixture-engine \(declared by packages\/coding-agent\/package\.json\)/);
			assert.match(error.message, /senpi-fixture-protocol \(declared by packages\/ai\/package\.json\)/);
			return true;
		});
	});
});
