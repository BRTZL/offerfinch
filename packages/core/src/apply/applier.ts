import {
	type BrowserPage,
	DESTINATION_REFUSED,
	type UploadFile,
	urlOnHosts,
} from "../scrape/browser";
import {
	type ApplicantData,
	BOARD_CONFIGS,
	type Board,
	type BoardConfig,
	errorsScript,
	exactOption,
	type FillAction,
	type FillPlan,
	type FormField,
	optionsScript,
	planFill,
	questionKeyOf,
	scanScript,
	successScript,
	type UnknownQuestion,
	VISIBLE_CHALLENGE_SCRIPT,
	verifyFilled,
} from "./forms";

/**
 * Drives one board's hosted application form: open, check for a challenge, fill from approved
 * data, screenshot, and (only in submit mode, only after `claim` agrees) click submit once and
 * read the outcome. Every stop before the click is safe: nothing was submitted. After the click,
 * anything but the board's confirmation is an unknown outcome and is never retried here.
 */

export type StopKind =
	| "challenge"
	| "unknown_questions"
	| "validation"
	| "unrecognized_page"
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
	board: Board;
	url: string;
	mode: "submit" | "dry_run";
	data: ApplicantData;
	files: FormFiles;
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
	 * Hosts the run may be on and send data to (a real submission). Checked after the form opens,
	 * before the files, before the claim and on the confirmation: the page must still be on one
	 * of them and must not have tried to navigate or send data elsewhere (the session's
	 * allowlist guard records those attempts).
	 */
	allowedHosts?: string[];
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

export type RunResult =
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
	  };

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

/** Loads the form; a stop when the page is a challenge, blocked, or not the form. */
export async function openForm(
	page: BrowserPage,
	url: string,
	config: BoardConfig,
): Promise<Stop | null> {
	const nav = await page.goto(url, { waitUntil: "load", timeoutMs: 45_000 });
	if (nav.status !== null && BLOCK_STATUSES.has(nav.status))
		return {
			kind: "challenge",
			message: `The board answered HTTP ${nav.status}.`,
		};
	try {
		await page.waitForSelector(config.root, { timeoutMs: 20_000 });
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
		if (wanted.has(key)) await page.check(`${at(field.ref)} >> nth=${index}`);
		else if (field.kind === "checkbox" && current.has(key))
			await page.uncheck(`${at(field.ref)} >> nth=${index}`);
	}
}

/** Runs one planned action; a stop when a combobox or location has no exact option. */
async function perform(
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
					await page.uncheck(`${at(action.ref)} >> nth=${index}`);
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
				await page.waitForTimeout(800);
				options =
					(await safeEvaluate<string[]>(page, optionsScript(action.ref))) ?? [];
				match =
					exactOption(action.value, options) ??
					(action.kind === "location"
						? (options.find((o) =>
								questionKeyOf(o).startsWith(questionKeyOf(action.value)),
							) ?? null)
						: null);
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
		case "file":
			await page.setInputFiles(at(action.ref), [
				action.file === "cv" ? files.cv : (files.coverLetter ?? files.cv),
			]);
			return null;
	}
}

/** Scans, plans and fills. Stops before the first keystroke when a required question is unknown. */
export async function fillForm(
	page: BrowserPage,
	config: BoardConfig,
	run: Pick<
		ApplicationRun,
		"data" | "files" | "beforeFill" | "beforeUpload" | "allowedHosts"
	>,
): Promise<
	| { ok: true; plan: FillPlan; filled: FilledField[] }
	| { ok: false; stop: Stop; filled: FilledField[] }
> {
	const fields = await page.evaluate<FormField[] | null>(scanScript(config));
	if (!fields)
		return {
			ok: false,
			filled: [],
			stop: {
				kind: "unrecognized_page",
				message: "The form disappeared while reading it.",
			},
		};
	const plan = planFill(fields, run.data);
	// Before the first interaction of any kind (clicks included): dry runs close the network here.
	run.beforeFill?.();
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
	const filled: FilledField[] = [];
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
			value:
				action.kind === "file"
					? action.file === "cv"
						? run.files.cv.name
						: (run.files.coverLetter?.name ?? "")
					: action.kind === "choose"
						? action.values.join("; ")
						: action.kind === "clear"
							? "(left blank)"
							: action.value,
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

/** Clicks submit once and waits for the confirmation; anything else is an unknown outcome. */
export async function submitForm(
	page: BrowserPage,
	config: BoardConfig,
	timeoutMs = 30_000,
	formUrl = page.url(),
): Promise<{ confirmed: string } | { unknown: string }> {
	await page.click(config.submit);
	const deadline = Date.now() + timeoutMs;
	let lastErrors: string[] = [];
	while (Date.now() < deadline) {
		await page.waitForTimeout(400);
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
	const config = BOARD_CONFIGS[run.board];
	let filled: FilledField[] = [];
	try {
		const opened = await openForm(page, run.url, config);
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
