import { describe, expect, it } from "vitest";

import { readOnlyDecision } from "../src/apply/network-guard";

describe("readOnlyDecision", () => {
	it("lets reads through and GraphQL queries", () => {
		expect(readOnlyDecision("GET", null).allow).toBe(true);
		expect(readOnlyDecision("HEAD", null).allow).toBe(true);
		expect(
			readOnlyDecision(
				"POST",
				JSON.stringify({
					operationName: "ApiJobPosting",
					query:
						"query ApiJobPosting($id: String!) { jobPosting(id: $id) { id } }",
				}),
			).allow,
		).toBe(true);
	});

	it("blocks mutations, form posts, uploads and other methods", () => {
		for (const [method, body] of [
			["POST", JSON.stringify({ query: "mutation Submit { submit { ok } }" })],
			["POST", JSON.stringify({ query: "query A { a } mutation B { b }" })],
			[
				"POST",
				JSON.stringify([
					{ query: "query A { a }" },
					{ query: "mutation B { b }" },
				]),
			],
			["POST", JSON.stringify({ name: "Ada", email: "a@b.c" })],
			["POST", "name=Ada&email=a%40b.c"],
			["POST", null],
			["PUT", "{}"],
			["PATCH", "{}"],
			["DELETE", null],
		] as const)
			expect(readOnlyDecision(method, body).allow, `${method} ${body}`).toBe(
				false,
			);
	});
});
