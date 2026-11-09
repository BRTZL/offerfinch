import { describe, expect, it } from "vitest";
import {
	evidenceLines,
	outcomeLabel,
	type StopApp,
	type StopAttempt,
	stopView,
} from "../src/renderer/components/pipeline/application/stop-model";

/** An attempt as the dashboard lists it; reasons are the sentences core stores. */
const attempt = (
	n: number,
	status: string,
	error: string | null,
	proof: Record<string, unknown> | null = null,
): StopAttempt => ({
	id: `a${n}`,
	attempt: n,
	status,
	mode: "auto",
	board: "greenhouse",
	url: "https://job-boards.greenhouse.io/acme/jobs/1",
	error,
	proof,
	startedAt: "2026-11-09T10:00:00.000Z",
});

const app = (over: Partial<StopApp>): StopApp => ({
	state: "needs_human",
	attempts: [],
	unresolvedAttempt: null,
	questions: [],
	submissionsPaused: false,
	...over,
});

describe("the stop sheet", () => {
	it("shows nothing unless the application needs the user", () => {
		expect(stopView(app({ state: "applied" }))).toBeNull();
		expect(stopView(app({ state: "approved" }))).toBeNull();
	});

	it("a challenge: finish it yourself first, retry only because nothing was clicked", () => {
		const view = stopView(
			app({
				attempts: [
					attempt(
						1,
						"not_sent",
						"A CAPTCHA frame on the form. Nothing was submitted.",
						{ stop: "challenge", filled: [] },
					),
				],
			}),
		);
		expect(view?.case).toBe("challenge");
		expect(view?.actions).toEqual(["finish", "mark", "retry"]);
		expect(view?.reason).toMatch(/CAPTCHA/);
	});

	it("a host outside SUBMIT_ALLOWED_HOSTS never offers a retry, with or without its kind", () => {
		const reason =
			"Automatic submission to jobs.lever.co is not turned on (SUBMIT_ALLOWED_HOSTS). Nothing was submitted.";
		for (const proof of [{ stop: "host_not_allowed" }, null]) {
			const view = stopView(
				app({ attempts: [attempt(1, "not_sent", reason, proof)] }),
			);
			expect(view?.case).toBe("host_not_allowed");
			expect(view?.actions).toEqual(["finish", "mark"]);
		}
	});

	it("an unknown outcome decides over a later stop, and its retry needs the confirmation", () => {
		const view = stopView(
			app({
				attempts: [
					attempt(
						2,
						"not_sent",
						"Attempt 1 is needs human; never submitting twice. Nothing was submitted.",
					),
					attempt(
						1,
						"needs_human",
						"Outcome unknown after a click that may have sent the application: No confirmation within 30s: the form is still on the page. Check the employer's portal or your email before retrying.",
					),
				],
				unresolvedAttempt: { attempt: 1 },
			}),
		);
		expect(view?.case).toBe("unknown_outcome");
		expect(view?.attempt?.attempt).toBe(1);
		expect(view?.actions).toEqual(["mark", "finish", "retry_confirmed"]);
		expect(view?.actions).not.toContain("retry");
	});

	it("an error answer to the application is an unknown outcome of its own", () => {
		const view = stopView(
			app({
				attempts: [
					attempt(
						1,
						"needs_human",
						"Outcome unknown after a click that may have sent the application: The page changed after the click, but the employer's site answered HTTP 500 to the application. Check the employer's portal or your email before retrying.",
					),
				],
				unresolvedAttempt: { attempt: 1 },
			}),
		);
		expect(view?.case).toBe("unknown_error_answer");
		expect(view?.actions).toEqual(["mark", "finish", "retry_confirmed"]);
	});

	it("refusal or error wording after the click is an unknown outcome of its own", () => {
		for (const said of [
			'The page after the click says "Your application could not be submitted", so the application may not have gone through.',
			'The employer\'s answer to the application says "Something went wrong", so it may not have gone through.',
			"The form showed errors after the click: Email is required",
		]) {
			const view = stopView(
				app({
					attempts: [
						attempt(
							1,
							"needs_human",
							`Outcome unknown after a click that may have sent the application: ${said} Check the employer's portal or your email before retrying.`,
						),
					],
					unresolvedAttempt: { attempt: 1 },
				}),
			);
			expect(view?.case).toBe("unknown_refused");
			expect(view?.actions).toEqual(["mark", "finish", "retry_confirmed"]);
		}
	});

	it("an employer's form to finish by hand: no Read the form again, no Retry", () => {
		const cases = [
			[
				"This form sends to sink.acme.test; finish it yourself. Nothing was submitted.",
				{ stop: "other_site" },
				"sends_elsewhere",
			],
			[
				"The application form is in a frame from forms.acme.test, not jobs.acme.test: this form sends to forms.acme.test; finish it yourself. Nothing was submitted.",
				{ stop: "other_site" },
				"sends_elsewhere",
			],
			[
				"The job link moves to careers.acme.test; finish it yourself. Nothing was submitted.",
				{ stop: "other_site" },
				"link_moves",
			],
			[
				"This form has unlabelled fields; finish it yourself. Nothing was submitted.",
				{ stop: "form_changed" },
				"unlabelled",
			],
			[
				"This form has fields that share one name or label; finish it yourself. Nothing was submitted.",
				{ stop: "form_changed" },
				"unlabelled",
			],
			[
				'Could not tell which control sends the application ("Preview details"); nothing more was clicked. Nothing was submitted.',
				{ stop: "unrecognized_page" },
				"no_submit",
			],
		] as const;
		for (const [reason, proof, expected] of cases) {
			const view = stopView(
				app({ attempts: [attempt(1, "not_sent", reason, proof)] }),
			);
			expect(view?.case).toBe(expected);
			expect(view?.actions).toEqual(["finish", "mark"]);
		}
	});

	it("a changed form offers Read the form again, never a plain retry", () => {
		const view = stopView(
			app({
				attempts: [
					attempt(
						1,
						"not_sent",
						'The form asks "Clearance", which review did not list. Nothing was submitted.',
						{ stop: "form_changed" },
					),
				],
			}),
		);
		expect(view?.case).toBe("form_changed");
		expect(view?.actions).toEqual(["reread", "finish", "mark"]);
	});

	it("a question goes to Questions; Lever's location is a choice among its suggestions", () => {
		const stopped = attempt(
			1,
			"not_sent",
			'"Current location" has no option matching the approved answer "Izmir". Nothing was submitted.',
		);
		const question = (board: string, label: string) => ({
			id: "q1",
			status: "open",
			formField: { board, label, options: ["Izmir, Turkey", "Izmit, Turkey"] },
		});
		const plain = stopView(
			app({
				attempts: [stopped],
				questions: [question("greenhouse", "Notice period")],
			}),
		);
		expect(plain?.case).toBe("question");
		expect(plain?.actions[0]).toBe("answer");
		expect(plain?.question?.id).toBe("q1");
		const location = stopView(
			app({
				attempts: [stopped],
				questions: [question("lever", "Current location")],
			}),
		);
		expect(location?.case).toBe("location_choice");
		expect(location?.actions).toEqual(["answer", "finish", "mark"]);
	});

	it("an upload to another host, an emailed code and a login wall: finish it yourself", () => {
		const cases = [
			[
				"The page tried to reach uploads.example.net, which is not an allowed host (POST). Nothing was submitted.",
				null,
				"other_host",
			],
			[
				"The page asks for a code sent to your email. Nothing was submitted.",
				{ stop: "verification_code" },
				"verification_code",
			],
			[
				'The page asks you to sign in before applying ("Sign in"). Nothing was submitted.',
				{ stop: "account_wall" },
				"account_wall",
			],
		] as const;
		for (const [reason, proof, expected] of cases) {
			const view = stopView(
				app({ attempts: [attempt(1, "not_sent", reason, proof)] }),
			);
			expect(view?.case).toBe(expected);
			expect(view?.actions).toEqual(["finish", "mark"]);
		}
	});

	it("paused: Retry only once submissions are on again", () => {
		const paused = attempt(
			1,
			"not_sent",
			"Submissions were paused before the form was opened. Nothing was submitted.",
			{ stop: "paused" },
		);
		expect(
			stopView(app({ attempts: [paused], submissionsPaused: true }))?.actions,
		).toEqual(["finish", "mark"]);
		expect(
			stopView(app({ attempts: [paused], submissionsPaused: false }))?.actions,
		).toEqual(["finish", "mark", "retry"]);
	});

	it("a dry run is not the stop", () => {
		const dry = {
			...attempt(2, "dry_run", "Dry run: 5 field(s) filled"),
			mode: "dry_run",
		};
		const view = stopView(
			app({
				attempts: [
					dry,
					attempt(
						1,
						"not_sent",
						"The submission run ended before it was cleared to submit (the worker stopped). Nothing was submitted.",
					),
				],
			}),
		);
		expect(view?.case).toBe("interrupted");
		expect(view?.actions[0]).toBe("retry");
	});
});

describe("an employer's form sent, check your email (decision 2026-11-09)", () => {
	const sent = (status: string, evidence: Record<string, unknown>) => ({
		...attempt(
			1,
			status,
			"Sent; check your email. The employer's form was submitted once; whether it arrived is told by the employer's email, not the page.",
			{ outcome: "web_sent", evidence, filled: [] },
		),
		board: "web",
	});

	it("whatever the page showed: Got the email first, nothing else until it did not go through", () => {
		for (const evidence of [
			{ requestSeen: true, confirmation: "Thank you", warning: null },
			{
				requestSeen: true,
				confirmation: null,
				warning:
					"The page changed after the click, but the employer's site answered HTTP 500 to the application.",
			},
			{ requestSeen: false, confirmation: null, warning: null },
		]) {
			const view = stopView(
				app({
					attempts: [sent("needs_human", evidence)],
					unresolvedAttempt: { attempt: 1 },
				}),
			);
			expect(view?.case).toBe("web_sent");
			expect(view?.title).toBe("Sent — check your email");
			expect(view?.actions).toEqual([
				"got_email",
				"finish_confirmed",
				"retry_confirmed",
			]);
			expect(view?.actions).not.toContain("retry");
		}
	});

	it("reads as sent, then as the user resolved it; never as the page's confirmation", () => {
		const e = { requestSeen: true, confirmation: "Thank you", warning: null };
		expect(outcomeLabel(sent("needs_human", e))).toBe(
			"Sent — check your email",
		);
		expect(outcomeLabel(sent("submitted", e))).toBe(
			"Sent, and you got the email",
		);
		expect(outcomeLabel(sent("not_sent", e))).toBe(
			"Sent, but it didn't go through",
		);
		// Got the email records the user's own attempt: never a board's confirmation.
		expect(
			outcomeLabel({ status: "submitted", board: null, mode: "manual" }),
		).toBe("Submitted by you");
	});

	it("shows what the run saw as information, a refusal as a warning", () => {
		expect(
			evidenceLines({
				outcome: "web_sent",
				evidence: {
					requestSeen: false,
					confirmation: "Thanks for applying",
					warning: 'The page after the click says "could not be submitted"',
					note: null,
				},
			}),
		).toEqual([
			{
				text: 'The page after the click says "could not be submitted"',
				warn: true,
			},
			{
				text: "The employer's page showed: “Thanks for applying”",
				warn: false,
			},
			{ text: "No application request was seen.", warn: false },
		]);
		expect(evidenceLines({ confirmation: "Thank you" })).toEqual([]);
	});
});

describe("the proof's outcome words", () => {
	it("never claim the employer received it", () => {
		const labels = ["submitted", "needs_human", "started", "not_sent"].map(
			(status) => outcomeLabel({ status, board: "lever" }),
		);
		expect(labels[0]).toBe("Submitted (board confirmed)");
		expect(labels[1]).toBe(
			"Outcome unknown: check your email or the employer's portal",
		);
		expect(labels[2]).toBe(labels[1]);
		expect(outcomeLabel({ status: "submitted", board: "web" })).toBe(
			"Submitted (the employer's page confirmed)",
		);
		for (const label of labels) expect(label).not.toMatch(/receiv/i);
	});
});
