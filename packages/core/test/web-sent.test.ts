import { describe, expect, it } from "vitest";
import { carriesApplication, decodeBody } from "../src/apply/web-sent";
import type { NetworkLogEntry } from "../src/scrape/browser";

/** Codex re-review (2026-11-09), finding 3: only the application request itself is evidence. */

const bytes = (text: string) => new TextEncoder().encode(text);
const post = (
	body: string,
	contentType: string,
	status = 200,
): NetworkLogEntry => ({
	method: "POST",
	url: "https://jobs.acme.com/apply",
	allowed: true,
	reason: "allowed host",
	status,
	body: bytes(body),
	contentType,
});

const VALUES = {
	typed: ["ada@example.test", "Ada Example", "Line one\nLine two"],
	cv: "CV.pdf",
};

describe("what counts as the application request", () => {
	it("reads form-encoded, JSON and multipart bodies", () => {
		const form = new URLSearchParams({
			email: "ada@example.test",
			name: "Ada Example",
			why: "Line one\r\nLine two",
		}).toString();
		expect(
			carriesApplication(
				post(form, "application/x-www-form-urlencoded"),
				VALUES,
			),
		).toBe(true);
		const json = JSON.stringify({
			candidate: { email: "ada@example.test", names: ["Ada Example"] },
			answers: [{ value: "Line one\nLine two" }],
		});
		expect(carriesApplication(post(json, "application/json"), VALUES)).toBe(
			true,
		);
		const multipart = [
			"--b",
			'Content-Disposition: form-data; name="email"',
			"",
			"ada@example.test",
			"--b",
			'Content-Disposition: form-data; name="name"',
			"",
			"Ada Example",
			"--b",
			'Content-Disposition: form-data; name="why"',
			"",
			"Line one\r\nLine two",
			"--b",
			'Content-Disposition: form-data; name="cv"; filename="CV.pdf"',
			"Content-Type: application/pdf",
			"",
			"%PDF-1.4 cv",
			"--b--",
			"",
		].join("\r\n");
		expect(
			carriesApplication(
				post(multipart, "multipart/form-data; boundary=b"),
				VALUES,
			),
		).toBe(true);
		expect(
			decodeBody(bytes(multipart), "multipart/form-data; boundary=b").files,
		).toEqual([{ name: "CV.pdf", pdf: true }]);
	});

	it("a click event, a partial body, a refusal or a value inside another is not", () => {
		expect(carriesApplication(post("event=click", "text/plain"), VALUES)).toBe(
			false,
		);
		expect(
			carriesApplication(
				post("email=ada%40example.test", "application/x-www-form-urlencoded"),
				VALUES,
			),
		).toBe(false);
		const whole = new URLSearchParams({
			email: "ada@example.test",
			name: "Ada Example",
			why: "Line one\nLine two",
		}).toString();
		expect(
			carriesApplication(
				post(whole, "application/x-www-form-urlencoded", 500),
				VALUES,
			),
		).toBe(false);
		expect(
			carriesApplication(
				post(
					JSON.stringify({ log: "typed ada@example.test, Ada Example" }),
					"application/json",
				),
				VALUES,
			),
		).toBe(false);
	});

	it("with nothing typed, only the CV file counts", () => {
		const only = { typed: [], cv: "CV.pdf" };
		const upload = [
			"--b",
			'Content-Disposition: form-data; name="resume"; filename="CV.pdf"',
			"",
			"%PDF-1.4 cv",
			"--b--",
		].join("\r\n");
		expect(
			carriesApplication(post(upload, "multipart/form-data; boundary=b"), only),
		).toBe(true);
		expect(carriesApplication(post("a=b", "text/plain"), only)).toBe(false);
	});
});
