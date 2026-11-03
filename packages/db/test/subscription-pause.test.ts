import { describe, expect, it } from "vitest";

import { subscriptionPauseOf } from "../src/dashboard";

describe("subscriptionPauseOf", () => {
	const paused = {
		billing: "subscription",
		error:
			"Subscription paused (usage_limit, claude-subscription:claude-sonnet-5-5): limit reached",
	};
	it("names the pause while the application waits on it", () => {
		expect(subscriptionPauseOf("preparing", [paused])).toBe(paused.error);
		expect(subscriptionPauseOf("found", [paused])).toBe(paused.error);
	});
	it("names a paid extra-usage pause, whose row is re-labelled api", () => {
		const paid = {
			billing: "api",
			error:
				"Subscription paused (extra_usage, claude-subscription:claude-sonnet-5-5): drew on paid extra usage",
		};
		expect(subscriptionPauseOf("found", [paid])).toBe(paid.error);
	});
	it("is gone once a later call ran, the application moved on, or the error was another", () => {
		expect(
			subscriptionPauseOf("preparing", [
				paused,
				{ billing: "subscription", error: null },
			]),
		).toBeNull();
		expect(subscriptionPauseOf("approved", [paused])).toBeNull();
		expect(
			subscriptionPauseOf("preparing", [{ billing: "api", error: "HTTP 500" }]),
		).toBeNull();
	});
});
