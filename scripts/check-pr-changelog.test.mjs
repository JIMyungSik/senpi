#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPrChangelog } from "./check-pr-changelog.mjs";

describe("check-pr-changelog gate", () => {
	it("fails when runtime package source changes without a changelog entry", () => {
		// Given
		const changedFiles = ["packages/ai/src/index.ts"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["packages/ai/src/index.ts"]);
	});

	it("passes when runtime source changes include a CHANGELOG.md edit", () => {
		// Given
		const changedFiles = ["packages/tui/src/components/app.ts", "packages/tui/CHANGELOG.md"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when runtime source changes carry the no-changelog label", () => {
		// Given
		const changedFiles = ["packages/agent/src/run.ts"];
		const labels = ["bug", "no-changelog"];

		// When
		const result = checkPrChangelog({ changedFiles, labels });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only test files change", () => {
		// Given
		const changedFiles = [
			"packages/coding-agent/src/cli.test.ts",
			"packages/ai/src/__tests__/models.test.ts",
		];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only docs change", () => {
		// Given
		const changedFiles = ["packages/ai/README.md", "docs/guide.md", "packages/tui/src/notes.md"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only workflows change", () => {
		// Given
		const changedFiles = [".github/workflows/ci.yml"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("fails when runtime source and tests change together without a changelog entry", () => {
		// Given
		const changedFiles = ["packages/pty/src/index.ts", "packages/pty/src/index.test.ts"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["packages/pty/src/index.ts"]);
	});

	it("fails when crates/senpi-pty changes without a changelog entry", () => {
		// Given
		const changedFiles = ["crates/senpi-pty/src/lib.rs"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, false);
		assert.deepEqual(result.runtimeFiles, ["crates/senpi-pty/src/lib.rs"]);
	});

	it("passes when only scripts and examples change", () => {
		// Given
		const changedFiles = ["scripts/local-release.mjs", "packages/senpi-codemode/examples/demo.ts"];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});

	it("passes when only generated model catalogs change (cl.md audit skip rule)", () => {
		// Given
		const changedFiles = [
			"packages/ai/src/models.generated.ts",
			"packages/ai/src/image-models.generated.ts",
		];

		// When
		const result = checkPrChangelog({ changedFiles, labels: [] });

		// Then
		assert.equal(result.pass, true);
	});
});
