import {
	type BrowserPage,
	DESTINATION_REFUSED,
	type UploadFile,
	urlOnHosts,
} from "../scrape/browser";
import { alignWithSchema, type SchemaField } from "./form-schema";
import {
	type ApplicantData,
	BOARD_CONFIGS,
	type Board,
	type BoardConfig,
	errorsScript,
	exactOption,
	type FillAction,
	type FillPlan,
	type FormBoard,
	type FormField,
	optionsScript,
	planFill,
	questionKeyOf,
	scanScript,
	successScript,
	systemRole,
	type UnknownQuestion,
	VISIBLE_CHALLENGE_SCRIPT,
	verifyFilled,
} from "./forms";
import type { WebFormModel } from "./web-model";

/**
 * Drives one board's hosted application form: open, check for a challenge, fill from approved
 * data, screenshot, and (only in submit mode, only after `claim` agrees) click submit once and
 * read the outcome. Every stop before the click is safe: nothing was submitted. After the click,
 * anything but the board's confirmation is an unknown outcome and is never retried here.
 */

export type StopKind =
	| "challenge"
	| "unknown_questions"
	/** The live form asks a required question the form read before review did not have. */
	| "form_changed"
	| "validation"
	| "unrecognized_page"
	/** The page asks for a password or a sign-in before its form (Rule 5: none is stored). */
	| "account_wall"
	/** The page asks for a code sent by email or SMS. */
	| "verification_code"
	/** The form sits on another site than the page that was opened (a frame from elsewhere). */
	| "other_site"
	| "error";

export interface Stop {
	kind: StopKind;
	message: string;
	questions?: UnknownQuestion[];
}

export interface FormFiles {
	cv: UploadFile;
	coverLetter: UploadFile | null;
}

export interface FilledField {
	label: string;
	value: string;
}

export interface ApplicationRun {
	/** "web": an employer's own form, run by `runWebApplication` (web-form.ts). */
	board: FormBoard;
	url: string;
	mode: "submit" | "dry_run";
	data: ApplicantData;
	files: FormFiles;
	/**
	 * The form as read before review, whose values the user approved. When set, a required
	 * question the live form adds stops the run, and self-identification questions take their
	 * "decline" option, as listed in review.
	 */
	schema?: SchemaField[];
	/** Called once the form is read, before the first click or keystroke (dry runs close the network). */
	beforeFill?: () => void;
	/** Called before the first file is chosen (boards upload on selection); a reason stops the run. */
	beforeUpload?: () => Promise<string | null>;
	/**
	 * The last gate before the click, with the "before" screenshot. Records the attempt; returning
	 * `go: false` (paused, a duplicate, an unresolved earlier attempt) stops with nothing sent.
	 */
	claim?: (
		before: Uint8Array,
		filled: FilledField[],
	) => Promise<{ go: true } | { go: false; reason: string }>;
	/** Waits for the confirmation this long after the click. */
	confirmTimeoutMs?: number;
	/**
	 * Dry runs with the network closed: a location field, whose suggestions come from a lookup
	 * over the network, is left untouched and listed as not chosen, so the rest of the form is
	 * still filled. Never set on a submission.
	 */
	lookupsOffline?: boolean;
	/**
	 * Hosts the run may be on and send data to (a real submission). Checked after the form opens,
	 * before the files, before the claim and on the confirmation: the page must still be on one
	 * of them and must not have tried to navigate or send data elsewhere (the session's
	 * allowlist guard records those attempts).
	 */
	allowedHosts?: string[];
	/**
	 * An employer's own form: the drafting model, for which button is which and what the page
	 * after the click says. Null or unset: those stay deterministic (and an unread outcome unknown).
	 */
	model?: WebFormModel | null;
	/**
	 * An employer's multi-step form: the claim comes before its first "Next" (a step may send
	 * answers); this is called before every later click that may send ("Next" or the submit). A
	 * reason ends the run as an unknown outcome, since an earlier step may have sent answers.
	 */
	beforeStep?: () => Promise<string | null>;
}

/** A stop when the page left the allowed hosts or tried to; null when it stayed. */
export function destinationProblem(
	page: BrowserPage,
	allowedHosts: string[] | undefined,
): string | null {
	if (!allowedHosts) return null;
	const refused = page
		.networkLog()
		.find((r) => r.reason === DESTINATION_REFUSED);
	if (refused)
		return `The page tried to reach ${hostOf(refused.url)}, which is not an allowed host (${refused.method}).`;
	if (!urlOnHosts(page.url(), allowedHosts))
		return `The page is on ${hostOf(page.url())}, which is not an allowed host.`;
	return null;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/**
 * One run's outcome. `steps`: an employer's multi-step form, a full-page screenshot of each step
 * as filled, taken before its "Next" (the last step is `before`); unset on single-page forms.
 */
export type RunResult = (
	| {
			outcome: "stopped";
			stop: Stop;
			screenshot: Uint8Array | null;
			filled: FilledField[];
	  }
	| {
			outcome: "dry_run";
			screenshot: Uint8Array;
			filled: FilledField[];
			blank: string[];
	  }
	| {
			outcome: "not_claimed";
			reason: string;
			screenshot: Uint8Array;
			filled: FilledField[];
	  }
	| {
			outcome: "submitted";
			before: Uint8Array;
			after: Uint8Array;
			confirmation: string;
			finalUrl: string;
			filled: FilledField[];
	  }
	| {
			outcome: "unknown";
			before: Uint8Array;
			after: Uint8Array | null;
			reason: string;
			finalUrl: string;
			filled: FilledField[];
	  }
	| {
			/**
			 * An employer's form after its one submit click (decision 2026-11-09): sent, and the user
			 * checks their email. Never applied from what the page shows; `evidence` is for the proof.
			 */
			outcome: "web_sent";
			before: Uint8Array;
			after: Uint8Array | null;
			finalUrl: string;
			filled: FilledField[];
			evidence: WebSentEvidence;
	  }
) & { steps?: Uint8Array[] };

/**
 * What the run saw after an employer's form was sent, shown in the proof and never deciding the
 * outcome: whether the request the click started carried the application, the page's own
 * confirmation words, a refusal or error seen after the click, and anything else it noted.
 */
export interface WebSentEvidence {
	requestSeen: boolean;
	confirmation: string | null;
	warning: string | null;
	note: string | null;
}

const BLOCK_STATUSES = new Set([401, 403, 407, 429, 503]);

async function shot(page: BrowserPage): Promise<Uint8Array | null> {
	try {
		return await page.screenshot({ fullPage: true });
	} catch {
		return null;
	}
}

async function safeEvaluate<T>(
	page: BrowserPage,
	script: string,
): Promise<T | null> {
	try {
		return await page.evaluate<T>(script);
	} catch {
		// A navigation destroyed the context mid-call; the next poll reads the new page.
		return null;
	}
}

/**
 * `waitForSelector`, cut short when the selector can no longer come: the page tried to leave
 * the allowed hosts (the refused navigation leaves an error page), or a challenge is shown
 * instead of the form. Waiting out the timeout would only delay the stop. Returns the
 * destination problem, null once the selector is there, and throws for a challenge or the
 * timeout (the caller reads the page to say which).
 */
async function waitForSelectorOrAway(
	page: BrowserPage,
	selector: string,
	timeoutMs: number,
	allowedHosts: string[] | undefined,
): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const away = destinationProblem(page, allowedHosts);
		if (away) return away;
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`No ${selector} within ${timeoutMs} ms.`);
		try {
			await page.waitForSelector(selector, { timeoutMs: Math.min(left, 500) });
			return null;
		} catch {}
		if (await safeEvaluate<string | null>(page, VISIBLE_CHALLENGE_SCRIPT))
			throw new Error("A challenge is shown instead of the form.");
	}
}

/**
 * Loads the form; a stop when the page is a challenge, blocked, not the form, or off the
 * allowed hosts.
 */
export async function openForm(
	page: BrowserPage,
	url: string,
	config: BoardConfig,
	allowedHosts?: string[],
): Promise<Stop | null> {
	const nav = await page.goto(url, { waitUntil: "load", timeoutMs: 45_000 });
	if (nav.status !== null && BLOCK_STATUSES.has(nav.status))
		return {
			kind: "challenge",
			message: `The board answered HTTP ${nav.status}.`,
		};
	try {
		const away = await waitForSelectorOrAway(
			page,
			config.root,
			20_000,
			allowedHosts,
		);
		if (away) return { kind: "unrecognized_page", message: away };
		// Scripts that load after `load` (Greenhouse fetches its locale bundle) must finish before
		// the form is used, and before a dry run closes the network.
		await page.waitForNetworkIdle(10_000);
	} catch {
		const challenge = await safeEvaluate<string | null>(
			page,
			VISIBLE_CHALLENGE_SCRIPT,
		);
		if (challenge)
			return {
				kind: "challenge",
				message: `${challenge} shown instead of the form.`,
			};
		return {
			kind: "unrecognized_page",
			message: `No ${config.board} application form at ${page.url()}.`,
		};
	}
	const challenge = await safeEvaluate<string | null>(
		page,
		VISIBLE_CHALLENGE_SCRIPT,
	);
	if (challenge)
		return { kind: "challenge", message: `${challenge} on the form.` };
	return null;
}

const at = (ref: string) => `[data-jp="${ref}"]`;

/** Page script: why the submit button cannot take a click (missing, or covered), else null. */
function coveredScript(submit: string): string {
	return `(() => {
	const button = document.querySelector(${JSON.stringify(submit)});
	if (!button) return "The submit button is not on the page.";
	button.scrollIntoView({ block: "center" });
	const r = button.getBoundingClientRect();
	const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
	if (!hit || hit === button || button.contains(hit)) return null;
	return "Something covers the submit button (a banner or dialog); it was not clicked.";
})()`;
}

/**
 * Page script: how to set a radio or checkbox the board hides or draws over (Workable,
 * Recruitee). "set" when it already holds the wanted state.
 * - "control": an ARIA radio or checkbox drawn around it takes the click (Workable). It is used
 *   only when it cannot submit: not a button without type="button", not an input or a link,
 *   and nothing inside it that submits or navigates. It is stamped for the caller to click.
 * - "native": the input is shown and on top; the caller ticks it the ordinary way.
 * - "set": otherwise the input element itself is clicked in the page. A radio's or checkbox's
 *   own click never submits a form, even inside a submit button. Labels and elements that merely
 *   name the input are never clicked.
 */
function hiddenChoiceScript(ref: string, index: number, on: boolean): string {
	return `(() => {
	const input = document.querySelectorAll('[data-jp="${ref}"]')[${index}];
	if (!input || (input.type !== "radio" && input.type !== "checkbox")) return "native";
	const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
	if (input.checked === ${on}) return "set";
	for (const el of document.querySelectorAll("[data-jp-click]")) el.removeAttribute("data-jp-click");
	// A drawn ARIA control handles the click itself (Workable ignores clicks on its inputs).
	const control = input.closest("[role=radio], [role=checkbox]");
	const submits = (el) => (el.tagName === "BUTTON" && (el.getAttribute("type") || "submit").toLowerCase() !== "button") || el.tagName === "INPUT" || (el.tagName === "A" && el.hasAttribute("href"));
	const safe = control && shown(control) && !submits(control) && ![...control.querySelectorAll("button, input, a[href]")].some((el) => el !== input && submits(el));
	if (safe) { control.setAttribute("data-jp-click", "1"); return "control"; }
	if (shown(input)) {
		input.scrollIntoView({ block: "center" });
		const box = input.getBoundingClientRect();
		const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
		if (hit && (hit === input || input.contains(hit))) return "native";
	}
	input.click();
	return "set";
})()`;
}

/**
 * Ticks or unticks one option. verifyFilled reads every control again afterwards, so a click the
 * board ignored is caught before the claim.
 */
async function setChoice(
	page: BrowserPage,
	field: FormField,
	index: number,
	on: boolean,
): Promise<void> {
	const how = await safeEvaluate<string>(
		page,
		hiddenChoiceScript(field.ref, index, on),
	);
	if (how === "set") return;
	if (how === "control") {
		await page.click("[data-jp-click]");
		return;
	}
	const selector = `${at(field.ref)} >> nth=${index}`;
	await (on ? page.check(selector) : page.uncheck(selector));
}

/** Ticks exactly the approved options; a checkbox the form had ticked otherwise is unticked. */
async function chooseIn(
	page: BrowserPage,
	field: FormField,
	values: string[],
): Promise<void> {
	const wanted = new Set(values.map(questionKeyOf));
	const current = new Set((field.current ?? []).map(questionKeyOf));
	for (const [index, option] of field.options.entries()) {
		const key = questionKeyOf(option);
		if (wanted.has(key)) await setChoice(page, field, index, true);
		else if (field.kind === "checkbox" && current.has(key))
			await setChoice(page, field, index, false);
	}
}

/**
 * Polls the options a combobox or location field shows for typed text, until one is exactly the
 * approved value or the time is up. Only an exact option is ever picked: review listed that value.
 */
async function suggestions(
	page: BrowserPage,
	ref: string,
	value: string,
	timeoutMs: number,
): Promise<{ options: string[]; match: string | null }> {
	const deadline = Date.now() + timeoutMs;
	let options: string[] = [];
	for (;;) {
		await page.waitForTimeout(250);
		options = (await safeEvaluate<string[]>(page, optionsScript(ref))) ?? [];
		const match = exactOption(value, options);
		if (match || Date.now() >= deadline) return { options, match };
	}
}

/** Runs one planned action; a stop when a combobox or location has no exact option. */
export async function perform(
	page: BrowserPage,
	action: FillAction,
	field: FormField,
	files: FormFiles,
): Promise<Stop | null> {
	switch (action.kind) {
		case "fill":
			await page.fill(at(action.ref), action.value);
			return null;
		case "select":
			await page.selectOption(at(action.ref), action.value);
			return null;
		case "choose":
			await chooseIn(page, field, action.values);
			return null;
		case "clear":
			if (action.control === "text") await page.fill(at(action.ref), "");
			else if (action.control === "select")
				await page.selectOption(at(action.ref), "");
			else
				for (const [index] of field.options.entries())
					await setChoice(page, field, index, false);
			return null;
		case "yesno": {
			const index = field.options.findIndex(
				(o) => questionKeyOf(o) === questionKeyOf(action.value),
			);
			await page.click(`${at(action.ref)} button >> nth=${index}`);
			return null;
		}
		case "combobox":
		case "location": {
			if (action.kind === "combobox") await page.click(at(action.ref));
			else await page.fill(at(action.ref), "");
			let options: string[] = [];
			let match: string | null = null;
			if (action.kind === "combobox") {
				await page.waitForTimeout(300);
				options =
					(await safeEvaluate<string[]>(page, optionsScript(action.ref))) ?? [];
				match = exactOption(action.value, options);
			}
			if (!match) {
				await page.type(at(action.ref), action.value);
				// Suggestions come after a debounce and a lookup (Lever: 500 ms, then a request).
				({ options, match } = await suggestions(
					page,
					action.ref,
					action.value,
					action.kind === "location" ? 5_000 : 800,
				));
			}
			if (!match) {
				await page.press(at(action.ref), "Escape").catch(() => {});
				return {
					kind: "unknown_questions",
					message: `"${action.label}" has no option matching the approved answer "${action.value}".`,
					questions: [
						{
							label: action.label,
							required: field.required,
							kind: field.kind,
							options: options.slice(0, 30),
							answered: action.value,
						},
					],
				};
			}
			await page.click(`[data-jp-option="${options.indexOf(match)}"]`);
			return null;
		}
		case "expect":
			// The page sets it from another value; `verifyFilled` checks what it holds.
			return null;
		case "file":
			await page.setInputFiles(at(action.ref), [
				action.file === "cv" ? files.cv : (files.coverLetter ?? files.cv),
			]);
			return null;
	}
}

/**
 * The scanned form, lined up with the schema read before review. Only what the user approved is
 * answered: a required question the form added since then stops the run, before the first
 * keystroke. Without a schema, the scan as it is.
 */
function againstSchema(
	scanned: FormField[] | null,
	schema: SchemaField[] | undefined,
): { fields: FormField[]; unreviewed: Set<string> } | { stop: Stop } {
	if (!scanned)
		return {
			stop: {
				kind: "unrecognized_page",
				message: "The form disappeared while reading it.",
			},
		};
	if (!schema) return { fields: scanned, unreviewed: new Set<string>() };
	const aligned = alignWithSchema(scanned, schema);
	if (aligned.unexpected.length === 0)
		return { fields: aligned.fields, unreviewed: aligned.unreviewed };
	return {
		stop: {
			kind: "form_changed",
			message: `The form now asks ${aligned.unexpected
				.map((q) => `"${q.label}"`)
				.join(", ")}, which was not in the approved list of what will be sent.`,
		},
	};
}

/** What a filled field records: the file's name, the chosen options, or the value. */
function filledValue(action: FillAction, files: FormFiles): string {
	switch (action.kind) {
		case "file":
			return action.file === "cv"
				? files.cv.name
				: (files.coverLetter?.name ?? "");
		case "choose":
			return action.values.join("; ");
		case "clear":
			return "(left blank)";
		default:
			return action.value;
	}
}

/**
 * The plan for the scanned form. Only reviewed fields get a value; a field the review never
 * listed is at most emptied. A dry run with the network closed cannot pick a location suggestion
 * (the field empties itself when left without one): that action is set apart, not performed.
 * A phone country the page derives is expected only when the phone number itself is typed.
 */
function reviewedPlan(
	fields: FormField[],
	unreviewed: Set<string>,
	run: Pick<ApplicationRun, "data" | "schema" | "lookupsOffline">,
	plainLocation: boolean,
): { plan: FillPlan; offline: Extract<FillAction, { kind: "location" }>[] } {
	const planned = planFill(fields, run.data, {
		declineVoluntary: run.schema !== undefined,
		plainLocation,
	});
	const kept = planned.actions.filter(
		(a) => !unreviewed.has(a.ref) || a.kind === "clear",
	);
	// The page sets the phone's country from the number: expected only if the number is typed.
	const phoneRefs = new Set(
		fields.filter((f) => systemRole(f) === "phone").map((f) => f.ref),
	);
	const typesPhone = kept.some(
		(a) => a.kind === "fill" && phoneRefs.has(a.ref),
	);
	const reviewed = kept.filter((a) => a.kind !== "expect" || typesPhone);
	const offline = run.lookupsOffline
		? reviewed.filter(
				(a): a is Extract<FillAction, { kind: "location" }> =>
					a.kind === "location",
			)
		: [];
	return {
		plan: {
			...planned,
			actions: reviewed.filter(
				(a) => a.kind !== "location" || !run.lookupsOffline,
			),
		},
		offline,
	};
}

/** The board's own cookie banner covers the form (Workable's backdrop): declines it once. */
export async function declineBoardCookies(
	page: BrowserPage,
	config: BoardConfig,
): Promise<void> {
	const button = config.declineCookies;
	if (!button) return;
	const shown = await safeEvaluate<boolean>(
		page,
		`(() => { const b = document.querySelector(${JSON.stringify(button)}); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
	);
	if (shown) await page.click(button).catch(() => {});
}

/** Scans, plans and fills. Stops before the first keystroke when a required question is unknown. */
export async function fillForm(
	page: BrowserPage,
	config: BoardConfig,
	run: Pick<
		ApplicationRun,
		| "data"
		| "files"
		| "beforeFill"
		| "beforeUpload"
		| "allowedHosts"
		| "schema"
		| "lookupsOffline"
	>,
): Promise<
	| { ok: true; plan: FillPlan; filled: FilledField[] }
	| { ok: false; stop: Stop; filled: FilledField[] }
> {
	const checked = againstSchema(
		await page.evaluate<FormField[] | null>(scanScript(config)),
		run.schema,
	);
	if ("stop" in checked) return { ok: false, filled: [], stop: checked.stop };
	const { fields, unreviewed } = checked;
	const { plan, offline } = reviewedPlan(
		fields,
		unreviewed,
		run,
		config.plainLocation === true,
	);
	// Before the first interaction of any kind (clicks included): dry runs close the network here,
	// and a submission fixes the files other hosts may serve.
	page.freezeAssets();
	run.beforeFill?.();
	await declineBoardCookies(page, config);
	// A combobox lists its options only when open: read them so the question can offer them.
	for (const question of plan.unknown) {
		const field = fields.find((f) => (f.label || f.name) === question.label);
		if (field?.kind !== "combobox" || question.options.length > 0) continue;
		await page.click(at(field.ref)).catch(() => {});
		await page.waitForTimeout(300);
		question.options =
			(await safeEvaluate<string[]>(page, optionsScript(field.ref)))?.slice(
				0,
				30,
			) ?? [];
		await page.press(at(field.ref), "Escape").catch(() => {});
	}
	if (plan.unknown.length > 0)
		return {
			ok: false,
			filled: [],
			stop: {
				kind: "unknown_questions",
				message: `${plan.unknown.length} required question(s) have no approved answer: ${plan.unknown
					.map((q) => `"${q.label}"`)
					.join(", ")}.`,
				questions: plan.unknown,
			},
		};
	const byRef = new Map(fields.map((f) => [f.ref, f]));
	const filled: FilledField[] = offline.map((a) => ({
		label: a.label,
		value: `${a.value} (not chosen: the suggestions need the network)`,
	}));
	let uploadsCleared = false;
	for (const action of plan.actions) {
		const field = byRef.get(action.ref);
		if (!field) continue;
		if (action.kind === "file" && !uploadsCleared) {
			const away = destinationProblem(page, run.allowedHosts);
			if (away)
				return {
					ok: false,
					filled,
					stop: { kind: "unrecognized_page", message: away },
				};
			const refused = (await run.beforeUpload?.()) ?? null;
			if (refused)
				return { ok: false, filled, stop: { kind: "error", message: refused } };
			uploadsCleared = true;
		}
		const stop = await perform(page, action, field, run.files);
		if (stop) return { ok: false, stop, filled };
		filled.push({
			label: action.label || field.name,
			value: filledValue(action, run.files),
		});
	}
	// Read the form again: every control must hold its approved value or nothing.
	const now = await safeEvaluate<FormField[] | null>(page, scanScript(config));
	const mismatches = now
		? verifyFilled(plan, fields, now)
		: ["The form disappeared while filling."];
	if (mismatches.length > 0)
		return {
			ok: false,
			filled,
			stop: {
				kind: "validation",
				message: `The filled form does not match the approved answers: ${mismatches.join(" ")}`,
			},
		};
	const errors =
		(await safeEvaluate<string[]>(page, errorsScript(config))) ?? [];
	if (errors.length > 0)
		return {
			ok: false,
			filled,
			stop: {
				kind: "validation",
				message: `The form shows errors before submitting: ${errors.join(" | ")}`,
			},
		};
	const challenge = await safeEvaluate<string | null>(
		page,
		VISIBLE_CHALLENGE_SCRIPT,
	);
	if (challenge)
		return {
			ok: false,
			filled,
			stop: {
				kind: "challenge",
				message: `${challenge} appeared while filling.`,
			},
		};
	return { ok: true, plan, filled };
}

/**
 * Clicks submit once and waits for the confirmation; anything else is an unknown outcome. A
 * request refused for leaving the allowed hosts ends the wait at once: the submission went
 * nowhere, and no confirmation will come.
 */
export async function submitForm(
	page: BrowserPage,
	config: BoardConfig,
	timeoutMs = 30_000,
	formUrl = page.url(),
	allowedHosts?: string[],
): Promise<{ confirmed: string } | { unknown: string }> {
	await page.click(config.submit);
	const deadline = Date.now() + timeoutMs;
	let lastErrors: string[] = [];
	while (Date.now() < deadline) {
		await page.waitForTimeout(400);
		const away = destinationProblem(page, allowedHosts);
		if (away) return { unknown: away };
		// Errors and challenges first; only then the board's own confirmation.
		const challenge = await safeEvaluate<string | null>(
			page,
			VISIBLE_CHALLENGE_SCRIPT,
		);
		if (challenge) return { unknown: `${challenge} appeared after the click.` };
		lastErrors =
			(await safeEvaluate<string[]>(page, errorsScript(config))) ?? lastErrors;
		if (lastErrors.length > 0) continue;
		const confirmed = await safeEvaluate<string | null>(
			page,
			successScript(config, formUrl),
		);
		if (confirmed) return { confirmed };
	}
	return {
		unknown: lastErrors.length
			? `The form showed errors after the click: ${lastErrors.join(" | ")}`
			: `No confirmation within ${Math.round(timeoutMs / 1000)}s.`,
	};
}

/** One complete run on an open page. Never throws after the click: errors become `unknown`. */
export async function runApplication(
	page: BrowserPage,
	run: ApplicationRun,
): Promise<RunResult> {
	// An employer's own form ("web") runs through `runWebApplication` (web-form.ts); submit.ts picks.
	const config = BOARD_CONFIGS[run.board as Board];
	let filled: FilledField[] = [];
	try {
		const opened = await openForm(page, run.url, config, run.allowedHosts);
		const awayAfterOpen = destinationProblem(page, run.allowedHosts);
		if (opened || awayAfterOpen)
			return {
				outcome: "stopped",
				stop: awayAfterOpen
					? { kind: "unrecognized_page", message: awayAfterOpen }
					: (opened as Stop),
				screenshot: await shot(page),
				filled,
			};
		const fill = await fillForm(page, config, run);
		filled = fill.filled;
		if (!fill.ok)
			return {
				outcome: "stopped",
				stop: fill.stop,
				screenshot: await shot(page),
				filled,
			};
		const before = await page.screenshot({ fullPage: true });
		// Revalidate right before the claim: still on an allowed host, still the form.
		const away = destinationProblem(page, run.allowedHosts);
		const stillForm = run.allowedHosts
			? await safeEvaluate<boolean>(
					page,
					`!!document.querySelector(${JSON.stringify(config.root)})`,
				)
			: true;
		if (away || !stillForm)
			return {
				outcome: "stopped",
				stop: {
					kind: "unrecognized_page",
					message: away ?? "The form is no longer on the page.",
				},
				screenshot: before,
				filled,
			};
		// A banner over the submit button would swallow the one click after the claim.
		const covered = await safeEvaluate<string | null>(
			page,
			coveredScript(config.submit),
		);
		if (covered)
			return {
				outcome: "stopped",
				stop: { kind: "unrecognized_page", message: covered },
				screenshot: before,
				filled,
			};
		if (run.mode === "dry_run")
			return {
				outcome: "dry_run",
				screenshot: before,
				filled,
				blank: fill.plan.blank,
			};
		const claimed = run.claim
			? await run.claim(before, filled)
			: ({ go: false, reason: "no claim gate" } as const);
		if (!claimed.go)
			return {
				outcome: "not_claimed",
				reason: claimed.reason,
				screenshot: before,
				filled,
			};
		try {
			const result = await submitForm(
				page,
				config,
				run.confirmTimeoutMs,
				page.url(),
				run.allowedHosts,
			);
			const after = (await shot(page)) ?? new Uint8Array();
			const awayAfter = destinationProblem(page, run.allowedHosts);
			if (awayAfter)
				return {
					outcome: "unknown",
					before,
					after,
					reason: awayAfter,
					finalUrl: page.url(),
					filled,
				};
			if ("confirmed" in result)
				return {
					outcome: "submitted",
					before,
					after,
					confirmation: result.confirmed,
					finalUrl: page.url(),
					filled,
				};
			return {
				outcome: "unknown",
				before,
				after,
				reason: result.unknown,
				finalUrl: page.url(),
				filled,
			};
		} catch (error) {
			return {
				outcome: "unknown",
				before,
				after: await shot(page),
				reason: `Error after the submit click: ${error instanceof Error ? error.message : String(error)}`,
				finalUrl: page.url(),
				filled,
			};
		}
	} catch (error) {
		const away = destinationProblem(page, run.allowedHosts);
		return {
			outcome: "stopped",
			stop: {
				kind: away ? "unrecognized_page" : "error",
				message: `${away ?? (error instanceof Error ? error.message : String(error))} (before submitting; nothing was sent)`,
			},
			screenshot: await shot(page),
			filled,
		};
	}
}
