import { describe, expect, it } from "vitest";
import {
	carriesApplication,
	decodeBody,
	htmlText,
	refusalIn,
} from "../src/apply/web-sent";
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

	it("reads a native GET form's query, never a POST's (Codex, 2026-11-09, third pass)", () => {
		const query = new URLSearchParams({
			email: "ada@example.test",
			name: "Ada Example",
			why: "Line one\nLine two",
		});
		const get = (method: string): NetworkLogEntry => ({
			method,
			url: `https://jobs.acme.com/sent?${query}`,
			allowed: true,
			reason: "allowed host",
			navigation: true,
			status: 200,
		});
		expect(carriesApplication(get("GET"), VALUES)).toBe(true);
		expect(carriesApplication(get("POST"), VALUES)).toBe(false);
	});
});

describe("refusal and error wording after the click (Codex, 2026-11-09, third pass)", () => {
	it.each([
		["Application could not be submitted", "could not be submitted"],
		["We couldn't send your application.", "couldn't send"],
		["Something went wrong. Please try again.", "Something went wrong"],
		["An error occurred", "error"],
		["Upload failed", "failed"],
		["Invalid email address", "Invalid"],
		["This field is required", "required"],
		["You have already applied to this job", "already applied"],
		["Duplicate application", "Duplicate"],
		["Bewerbung fehlgeschlagen", "fehlgeschlagen"],
		["Dieses Feld ist ungültig", "ungültig"],
		["Une erreur est survenue", "erreur"],
		["Échec de l'envoi", "Échec"],
		["Este campo es obligatorio", "obligatorio"],
		["Por favor, inténtalo de nuevo", "inténtalo de nuevo"],
	])("finds %j", (text, hit) => {
		expect(refusalIn(`Thank you for applying! ${text}`)).toBe(hit);
	});

	it.each([
		"Thank you for applying! We have received your application and will reply by email.",
		"Vielen Dank für Ihre Bewerbung. Sie ist bei uns eingegangen.",
		"Merci pour votre candidature.",
		// Whole words only: neither inside a longer word.
		"Our terrors team and errorless requiredness",
	])("finds nothing in %j", (text) => {
		expect(refusalIn(text)).toBeNull();
	});

	it("reads an HTML answer's text, hidden parts kept and scripts dropped", () => {
		const html =
			'<html><head><script>console.error("x")</script><style>.error{}</style></head><body><h1>Thank you for applying!</h1><div style="display:none">Application could not be submitted</div></body></html>';
		expect(htmlText(html)).toBe(
			"Thank you for applying! Application could not be submitted",
		);
		expect(refusalIn(htmlText(html))).toBe("could not be submitted");
		expect(
			refusalIn(htmlText("<script>if (error) fail()</script><p>Thanks</p>")),
		).toBeNull();
	});
});
