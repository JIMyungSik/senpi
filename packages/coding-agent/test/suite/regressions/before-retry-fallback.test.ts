import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeRetryFallbackEvent, ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const billingError = "billing error: insufficient_quota";
const noHint429 = "HTTP 429: rate_limit_exceeded - All tokens rate limited";
const transient500 = "HTTP 500: internal_error";
const xaiCreditsError =
	'OpenAI API error (403): 403 "You have run out of credits or need a Grok subscription."';

type SeenFallbackEvent = Pick<BeforeRetryFallbackEvent, "type" | "provider" | "model" | "reason">;

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

function fallbackSettings() {
	return {
		retry: {
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 1,
			fallbackChains: { [primary]: [fallback] },
		},
	};
}

function retryOnceFactory(seen: SeenFallbackEvent[]) {
	return (pi: ExtensionAPI) => {
		let remaining = 1;
		pi.on("before_retry_fallback", (event) => {
			seen.push({
				type: event.type,
				provider: event.provider,
				model: event.model,
				reason: event.reason,
			});
			expect(event).not.toHaveProperty("apiKey");
			expect(event).not.toHaveProperty("authorization");
			expect(event).not.toHaveProperty("headers");
			expect(event).not.toHaveProperty("credentials");
			expect(Object.keys(event).sort()).toEqual(["model", "provider", "reason", "type"]);
			if (remaining > 0) {
				remaining -= 1;
				return { action: "retry-same-model" };
			}
			return undefined;
		});
	};
}

function alwaysRetryFactory(seen: SeenFallbackEvent[]) {
	return (pi: ExtensionAPI) => {
		pi.on("before_retry_fallback", (event) => {
			seen.push({
				type: event.type,
				provider: event.provider,
				model: event.model,
				reason: event.reason,
			});
			return { action: "retry-same-model" };
		});
	};
}

function observeFactory(seen: SeenFallbackEvent[]) {
	return (pi: ExtensionAPI) => {
		pi.on("before_retry_fallback", (event) => {
			seen.push({
				type: event.type,
				provider: event.provider,
				model: event.model,
				reason: event.reason,
			});
		});
	};
}

describe("before_retry_fallback", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("retries the same model once on a billing hard error before native fallback", async () => {
		const seen: SeenFallbackEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [retryOnceFactory(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(billingError), fauxAssistantMessage("same-model recovery")]);

		await harness.session.prompt("billing retry");

		expect(seen).toEqual([{ type: "before_retry_fallback", provider: "faux", model: "faux-1", reason: "billing" }]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("allows an account extension retry when no native fallback chain exists", async () => {
		const seen: SeenFallbackEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
				},
			},
			extensionFactories: [retryOnceFactory(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(xaiCreditsError), fauxAssistantMessage("account retry recovered")]);

		await harness.session.prompt("retry account without a model chain");

		expect(seen).toEqual([
			{ type: "before_retry_fallback", provider: "faux", model: "faux-1", reason: "billing" },
		]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("retries the same model once on a no-hint 429 before native fallback", async () => {
		const seen: SeenFallbackEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [retryOnceFactory(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(noHint429), fauxAssistantMessage("same-model recovery")]);

		await harness.session.prompt("429 retry");

		expect(seen).toEqual([{ type: "before_retry_fallback", provider: "faux", model: "faux-1", reason: "transient" }]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0]);
	});

	it("advances to the configured fallback exactly once after a second failure without another retry decision", async () => {
		const seen: SeenFallbackEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [retryOnceFactory(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([
			errorTurn(billingError),
			errorTurn(billingError),
			fauxAssistantMessage("fallback recovered"),
		]);

		await harness.session.prompt("second failure fallback");

		expect(seen).toEqual([
			{ type: "before_retry_fallback", provider: "faux", model: "faux-1", reason: "billing" },
			{ type: "before_retry_fallback", provider: "faux", model: "faux-1", reason: "billing" },
		]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "billing" },
		]);
	});

	it("bounds an always-retry handler by the turn retry budget and still falls back once", async () => {
		const seen: SeenFallbackEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [alwaysRetryFactory(seen)],
		});
		harnesses.push(harness);
		harness.setResponses([
			errorTurn(billingError),
			errorTurn(billingError),
			fauxAssistantMessage("fallback recovered"),
		]);

		await harness.session.prompt("budget bound");

		expect(seen).toHaveLength(2);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
	});

	it("fails open to native fallback when a handler throws", async () => {
		const extensionErrors: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [
				(pi) => {
					pi.on("before_retry_fallback", () => {
						throw new Error("prefallback boom");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.getExtensionRunner().onError((error) => {
			extensionErrors.push(error.error);
		});
		harness.setResponses([errorTurn(billingError), fauxAssistantMessage("fallback recovered")]);

		await harness.session.prompt("handler throw");

		expect(extensionErrors).toEqual(["prefallback boom"]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "billing" },
		]);
	});

	it("lets an extension stop model fallback for a non-eligible failure", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [
				(pi) => {
					pi.on("before_retry_fallback", () => ({ action: "stop" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(billingError)]);

		await harness.session.prompt("blocked fallback");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("gives stop precedence over retry across extension handlers", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [
				(pi) => {
					pi.on("before_retry_fallback", () => ({ action: "retry-same-model" }));
				},
				(pi) => {
					pi.on("before_retry_fallback", () => ({ action: "stop" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([errorTurn(billingError)]);

		await harness.session.prompt("stop wins");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("does not emit the hook for non-eligible errors", async () => {
		const seen: SeenFallbackEvent[] = [];
		const toolCallHarness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: fallbackSettings(),
			extensionFactories: [observeFactory(seen)],
		});
		harnesses.push(toolCallHarness);
		toolCallHarness.setResponses([
			fauxAssistantMessage([fauxToolCall("unsafe", {})], {
				stopReason: "error",
				errorMessage: billingError,
			}),
		]);

		await toolCallHarness.session.prompt("tool call hard error");

		expect(seen).toEqual([]);
		expect(toolCallHarness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(toolCallHarness.faux.state.callCount).toBe(1);

		const transientSeen: SeenFallbackEvent[] = [];
		const transientHarness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
			extensionFactories: [observeFactory(transientSeen)],
		});
		harnesses.push(transientHarness);
		transientHarness.setResponses([errorTurn(transient500), fauxAssistantMessage("recovered in place")]);

		await transientHarness.session.prompt("in-budget transient");

		expect(transientSeen).toEqual([]);
		expect(transientHarness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(transientHarness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("keeps retry decisions isolated across concurrent sessions", async () => {
		const retrySeen: SeenFallbackEvent[] = [];
		const observeSeen: SeenFallbackEvent[] = [];
		const retryHarness = await createHarness({
			provider: "faux-retry",
			api: "faux-retry",
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					fallbackChains: { "faux-retry/faux-1": ["faux-retry/faux-2"] },
				},
			},
			extensionFactories: [retryOnceFactory(retrySeen)],
		});
		const observeHarness = await createHarness({
			provider: "faux-observe",
			api: "faux-observe",
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					fallbackChains: { "faux-observe/faux-1": ["faux-observe/faux-2"] },
				},
			},
			extensionFactories: [observeFactory(observeSeen)],
		});
		harnesses.push(retryHarness, observeHarness);
		retryHarness.setResponses([errorTurn(billingError), fauxAssistantMessage("retry recovered")]);
		observeHarness.setResponses([errorTurn(billingError), fauxAssistantMessage("immediate fallback")]);

		await Promise.all([
			retryHarness.session.prompt("isolated retry"),
			observeHarness.session.prompt("isolated fallback"),
		]);

		expect(retrySeen).toEqual([
			{ type: "before_retry_fallback", provider: "faux-retry", model: "faux-1", reason: "billing" },
		]);
		expect(observeSeen).toEqual([
			{ type: "before_retry_fallback", provider: "faux-observe", model: "faux-1", reason: "billing" },
		]);
		expect(retryHarness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(observeHarness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(retryHarness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(observeHarness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: "faux-observe/faux-1", to: "faux-observe/faux-2", reason: "billing" },
		]);
	});
});
