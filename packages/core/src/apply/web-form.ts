import {
	type BrowserPage,
	type NetworkLogEntry,
	urlOnHosts,
} from "../scrape/browser";
import {
	type ApplicationRun,
	destinationProblem,
	type FilledField,
	perform,
	type RunResult,
	type Stop,
} from "./applier";
import {
	type FormReadRefusal,
	type FormSchema,
	type SchemaField,
	schemaKey,
} from "./form-schema";
import {
	type FillAction,
	type FillPlan,
	type FormField,
	optionsScript,
	planFill,
	systemRole,
	VISIBLE_CHALLENGE_SCRIPT,
	verifyFilled,
} from "./forms";
import { linkMoved, webFormHost } from "./web-hosts";
import type { ControlRole, WebFormModel } from "./web-model";
import {
	PAGE_TEXT_SCRIPT,
	WEB_AFTER_SCRIPT,
	WEB_SCAN_SCRIPT,
	type WebAfter,
	type WebControl,
	type WebField,
	type WebScan,
	webCoveredScript,
} from "./web-scan";
import {
	answeredOk,
	carriesValues,
	htmlText,
	refusalIn,
	type SentValues,
} from "./web-sent";

/**
 * An employer's own application form (the "web" board, docs/auto-apply-plan.md step 6): read
 * before review, filled from the approved plan, step by step, and submitted once after the claim.
 * The model only labels controls nothing on the page names, says which button is which, and
 * reads the page after the click; every value comes from `planFill`, and a control lines up with
 * a reviewed field by its key alone. A "Next" is clicked only when the reviewed form has a later step and the
 * button's own text says next; any other control that may send is the final submit, clicked only
 * after the claim.
 */

/** A field of the saved schema, as read from an employer's form. */
export interface WebSchemaField extends SchemaField {
	/** "model": the page names nothing; the drafting model chose this label from the page's own text. */
	labelSource?: "page" | "model";
}

const BLOCK_STATUSES = new Set([401, 403, 407, 429, 503]);
const MAX_STEPS = 6;

/** Standard field names the model may label a control with (they match `systemRole`). */
const STANDARD_LABELS = [
	"Full name",
	"First name",
	"Last name",
	"Email",
	"Phone",
	"Location",
	"LinkedIn",
	"GitHub",
	"Website",
	"Resume",
	"Cover letter",
];

/** A control's label from its `autocomplete` token or input type, when the page names nothing. */
const AUTOCOMPLETE_LABELS: Record<string, string> = {
	name: "Full name",
	"given-name": "First name",
	"family-name": "Last name",
	email: "Email",
	tel: "Phone",
	"tel-national": "Phone",
	url: "Website",
};

const NEXT_WORDS =
	/^(?:next|continue|weiter|suivant|siguiente|avanti|volgende|proceed|next step|save (?:and|&) continue)\b/i;
const SUBMIT_WORDS =
	/\b(?:submit|apply|send|absenden|bewerben|envoyer|postuler|enviar|finish)\b/i;
const OTHER_WORDS =
	/\b(?:back|previous|prev|cancel|reset|clear|remove|delete|upload|attach|browse|choose|add (?:another|more)|sign ?in|log ?in|register|zurück|abbrechen|edit|change|accept|decline|reject|cookies?|search|subscribe|linkedin|indeed|google|save (?:for later|draft)|share)\b/i;

/** Words a page uses to say the application arrived. */
const CONFIRMED =
	/thank you for (?:applying|your application|your interest)|thanks for applying|application (?:has been |was )?(?:received|submitted|sent)|received your application|successfully (?:submitted|applied|sent)|vielen dank für (?:ihre|deine) bewerbung|bewerbung (?:ist )?(?:eingegangen|erhalten)|merci pour votre candidature|candidature (?:a été )?(?:envoyée|reçue)|gracias por (?:tu|su) (?:solicitud|postulación)/i;

async function safeEvaluate<T>(
	page: BrowserPage,
	script: string,
): Promise<T | null> {
	try {
		return await page.evaluate<T>(script);
	} catch {
		return null;
	}
}

async function shot(page: BrowserPage): Promise<Uint8Array | null> {
	try {
		return await page.screenshot({ fullPage: true });
	} catch {
		return null;
	}
}

const scanOf = (page: BrowserPage) =>
	safeEvaluate<WebScan>(page, WEB_SCAN_SCRIPT);
const challengeOf = (page: BrowserPage) =>
	safeEvaluate<string | null>(page, VISIBLE_CHALLENGE_SCRIPT);

/** A stop for what the page asks before its form: a password, a sign-in, a code. */
function wallOf(scan: WebScan): Stop | null {
	if (scan.password)
		return {
			kind: "account_wall",
			message:
				"The page asks for a password: this form needs an account, and no passwords are stored.",
		};
	if (scan.code)
		return {
			kind: "verification_code",
			message: `The page asks for a code sent by email or SMS ("${scan.code}").`,
		};
	if (scan.signIn && scan.fields.length === 0)
		return {
			kind: "account_wall",
			message: `The page asks you to sign in before applying ("${scan.signIn}").`,
		};
	return null;
}

/** Polls until the page shows a form, a wall, a frame or a challenge, or the time is up. */
async function awaitForm(
	page: BrowserPage,
	allowedHosts: string[] | undefined,
	timeoutMs: number,
): Promise<{ scan: WebScan } | { stop: Stop }> {
	const deadline = Date.now() + timeoutMs;
	let scan: WebScan | null = null;
	for (;;) {
		const away = destinationProblem(page, allowedHosts);
		if (away) return { stop: { kind: "other_site", message: away } };
		const challenge = await challengeOf(page);
		if (challenge)
			return {
				stop: {
					kind: "challenge",
					message: `${challenge} shown instead of the form.`,
				},
			};
		scan = await scanOf(page);
		if (
			scan &&
			(scan.fields.length > 0 ||
				scan.frameUrl ||
				scan.frameHost ||
				scan.password ||
				scan.signIn)
		)
			break;
		if (Date.now() >= deadline) break;
		await page.waitForTimeout(500);
	}
	// Scripts that load after `load` must finish before the form is used (and a read closes the network).
	await page.waitForNetworkIdle(5_000);
	scan = (await scanOf(page)) ?? scan;
	if (!scan)
		return {
			stop: {
				kind: "unrecognized_page",
				message: `The page at ${page.url()} could not be read.`,
			},
		};
	return { scan };
}

/** A stop for a form that would send elsewhere than its page's host: the user finishes it. */
const sendsTo = (host: string): Stop => ({
	kind: "other_site",
	message: `This form sends to ${host}; finish it yourself.`,
});

const hostOf = (url: string): string | null => {
	try {
		const { protocol, hostname } = new URL(url);
		return /^https?:$/.test(protocol) ? hostname.toLowerCase() : null;
	} catch {
		return null;
	}
};

/**
 * Where the page is, or says it sends (its `action`, a `formaction`), when that is not the exact
 * host of the form's page: data goes to that host alone, so the form is the user's to finish.
 */
function elsewhere(
	page: BrowserPage,
	scan: WebScan,
	formHost: string,
): Stop | null {
	const here = hostOf(page.url());
	if (here && here !== formHost) return sendsTo(here);
	for (const endpoint of scan.endpoints) {
		const host = hostOf(endpoint);
		if (host && host !== formHost) return sendsTo(host);
	}
	return null;
}

/**
 * Opens an employer's form; a stop when the page is blocked, a challenge, a wall, on another
 * host, sends elsewhere, or shows no form. The form's page is where the HTTP redirects led (the
 * browser follows them before any script runs), and only when they kept the link's own host; a
 * redirect, a script or a meta refresh that moves the page to another host, a frame from another
 * host, or an `action` or `formaction` naming one is a hand-off. A form in a frame of the same
 * host is opened on its own.
 */
export async function openWebForm(
	page: BrowserPage,
	url: string,
	allowedHosts?: string[],
): Promise<{ scan: WebScan; formUrl: string } | { stop: Stop }> {
	const nav = await page.goto(url, { waitUntil: "load", timeoutMs: 45_000 });
	if (nav.status !== null && BLOCK_STATUSES.has(nav.status))
		return {
			stop: {
				kind: "challenge",
				message: `The site answered HTTP ${nav.status}.`,
			},
		};
	const formUrl = nav.responseUrl ?? url;
	// An HTTP redirect to another host never makes that host the destination: the user finishes it.
	const moved = linkMoved(url, formUrl);
	if (moved) return { stop: { kind: "other_site", message: moved } };
	const formHost = webFormHost(formUrl);
	let found = await awaitForm(page, allowedHosts, 15_000);
	if ("stop" in found) return found;
	const here = hostOf(page.url());
	if (here && here !== formHost) return { stop: sendsTo(here) };
	const frame = found.scan.frameUrl;
	if (frame) {
		const there = new URL(frame, page.url());
		if (there.hostname.toLowerCase() !== formHost)
			return {
				stop: {
					kind: "other_site",
					message: `The application form is in a frame from ${there.host}, not ${formHost}: this form sends to ${there.hostname}; finish it yourself.`,
				},
			};
		await page.goto(there.href, { waitUntil: "load", timeoutMs: 45_000 });
		found = await awaitForm(page, allowedHosts, 15_000);
		if ("stop" in found) return found;
	}
	const { scan } = found;
	const away = elsewhere(page, scan, formHost);
	if (away) return { stop: away };
	if (scan.frameHost)
		return {
			stop: {
				kind: "other_site",
				message: `The application form is in a frame from ${scan.frameHost}, another site; apply there yourself.`,
			},
		};
	const wall = wallOf(scan);
	if (wall) return { stop: wall };
	if (scan.fields.length === 0)
		return {
			stop: {
				kind: "unrecognized_page",
				message: `No application form at ${page.url()}.`,
			},
		};
	return { scan, formUrl };
}

/* -------------------------------------------------------------- controls */

function wordsRole(control: WebControl): ControlRole | null {
	if (OTHER_WORDS.test(control.text)) return "other";
	if (NEXT_WORDS.test(control.text) && !SUBMIT_WORDS.test(control.text))
		return "next";
	if (SUBMIT_WORDS.test(control.text)) return "submit";
	return null;
}

/**
 * The controls with deterministic evidence that they send the form: a submit button that belongs
 * to the form (`<button>` without another type or `<input type=submit>` inside it, or one whose
 * `form` attribute names it; web-scan.ts types these "submit"). Only these can ever be the submit;
 * a plain button, whatever its words, never is.
 */
function submitCapable(controls: WebControl[]): Set<string> {
	return new Set(
		controls
			.filter((c) => c.type === "submit" && wordsRole(c) !== "other")
			.map((c) => c.ref),
	);
}

/**
 * The model's roles, where the words allow them: a control the words call something else
 * (back, upload, sign in) stays that; "next" only where the words say next; the submit never
 * where they say next, and only on a control that already may send (`submitCapable`). The model
 * may drop a would-be submit to "other".
 */
function mergeModelRoles(
	roles: Map<string, ControlRole | null>,
	answers: { ref: string; role: ControlRole }[],
	capable: Set<string>,
): void {
	for (const { ref, role } of answers) {
		const words = roles.get(ref);
		if (words === undefined || words === "other") continue;
		if (role === "next" && words !== "next") continue;
		if (role === "submit" && (words === "next" || !capable.has(ref))) continue;
		roles.set(ref, role);
	}
}

/**
 * Which control moves to the next step and which sends the application. From their words; the
 * model is asked only when the words leave it open (no control, or more than one, for a role).
 * The model can never make a control "next" whose text does not say so, nor make a control
 * whose text says otherwise, or that nothing shows may send, the submit.
 */
export async function controlRoles(
	controls: WebControl[],
	model: WebFormModel | null | undefined,
): Promise<{ next: WebControl | null; submit: WebControl | null }> {
	const roles = new Map(controls.map((c) => [c.ref, wordsRole(c)]));
	const capable = submitCapable(controls);
	const count = (role: ControlRole) =>
		[...roles.values()].filter((r) => r === role).length;
	const open =
		count("next") > 1 ||
		count("submit") > 1 ||
		(count("next") === 0 && count("submit") === 0);
	if (open && model)
		mergeModelRoles(
			roles,
			await model
				.controls({
					controls: controls.map(({ ref, text, type }) => ({
						ref,
						text,
						type,
					})),
				})
				.catch(() => []),
			capable,
		);
	const pick = (role: ControlRole) => {
		const all = controls.filter(
			(c) =>
				roles.get(c.ref) === role && (role !== "submit" || capable.has(c.ref)),
		);
		return all.length === 1 ? (all[0] ?? null) : null;
	};
	let submit = pick("submit");
	// Without words or a model: the form's only submit button is its submit.
	if (!submit && count("submit") === 0) {
		const buttons = controls.filter(
			(c) => c.type === "submit" && roles.get(c.ref) === null,
		);
		if (buttons.length === 1) submit = buttons[0] ?? null;
	}
	return { next: pick("next"), submit };
}

/* ---------------------------------------------------------------- reading */

/** The label of a control the page names nothing for, from its autocomplete token or type. */
function plainLabel(field: WebField): string {
	if (field.label) return field.label;
	return (
		AUTOCOMPLETE_LABELS[field.autocomplete] ??
		(field.inputType === "email"
			? "Email"
			: field.inputType === "tel"
				? "Phone"
				: "")
	);
}

/** Reads the options each visible combobox shows when opened (the network is closed by then). */
async function readComboboxes(page: BrowserPage, fields: WebField[]) {
	for (const field of fields) {
		if (field.kind !== "combobox" || field.options.length > 0 || !field.visible)
			continue;
		const at = `[data-jp="${field.ref}"]`;
		await page.click(at).catch(() => {});
		await page.waitForTimeout(300);
		field.options =
			(await safeEvaluate<string[]>(page, optionsScript(field.ref)))?.slice(
				0,
				50,
			) ?? [];
		await page.press(at, "Escape").catch(() => {});
	}
}

const UNLABELLED: Stop = {
	kind: "form_changed",
	message: "This form has unlabelled fields; finish it yourself.",
};

/**
 * Why a scan's controls cannot each be told apart by something of their own: a control with no
 * name, no stable id and no label (keyed only by its place, `#text-1`), or two controls with one
 * key. A form like that is the user's to finish: a place or a shared key is never filled from.
 */
function unlabelledProblem(scanned: WebField[]): Stop | null {
	if (scanned.some((f) => f.name.startsWith("#"))) return UNLABELLED;
	const keys = scanned
		.filter((f) => f.kind !== "radio" && f.kind !== "checkbox")
		.map(schemaKey);
	if (new Set(keys).size < keys.length)
		return {
			kind: "form_changed",
			message:
				"This form has fields that share one name or label; finish it yourself.",
		};
	return null;
}

/** Adds a scan's new fields to the read (a step shown again after "Next" adds nothing new). */
function addRead(
	fields: { field: WebField; page: number }[],
	keys: Set<string>,
	scanned: WebField[],
	step: number,
): void {
	const last = fields.reduce((m, f) => Math.max(m, f.page), 0);
	for (const field of scanned) {
		const key = schemaKey(field);
		if (keys.has(key)) continue;
		keys.add(key);
		// Hidden steps count after the one shown; a step drawn after "Next" follows the last read.
		fields.push({ field, page: step === 1 ? field.step : last + 1 });
	}
}

/**
 * Reads an employer's form on a page whose session is read-only, closing the network after the
 * first scan. Steps the page keeps hidden are read as later pages; steps it draws only after
 * "Next" are reached by clicking "Next" with the network closed and nothing typed, as far as the
 * form lets it. A control with a name or stable id but no label is labelled by the model from the
 * page's own text, or left without a label; a control with none of these, or two controls with one
 * key, make the form a hand-off (`unlabelledProblem`).
 */
export async function readWebFormOnPage(
	page: BrowserPage,
	url: string,
	model?: WebFormModel | null,
): Promise<{ ok: true; schema: FormSchema } | FormReadRefusal> {
	const opened = await openWebForm(page, url);
	if ("stop" in opened)
		return {
			ok: false,
			reason: opened.stop.message,
			// Another site or host: read, and the user's to finish there.
			...(opened.stop.kind === "other_site" ? { handoff: true as const } : {}),
		};
	page.restrictNetwork("none");
	const formHost = webFormHost(opened.formUrl);
	const fields: { field: WebField; page: number }[] = [];
	const keys = new Set<string>();
	let scan = opened.scan;
	let submit: WebControl | null = null;
	let canSubmit = scan.canSubmit;
	for (let step = 1; step <= MAX_STEPS; step++) {
		const unlabelled = unlabelledProblem(scan.fields);
		if (unlabelled)
			return { ok: false, reason: unlabelled.message, handoff: true };
		await readComboboxes(page, scan.fields);
		const before = fields.length;
		addRead(fields, keys, scan.fields, step);
		const roles = await controlRoles(scan.controls, model);
		submit = roles.submit ?? submit;
		if (!roles.next || (step > 1 && fields.length === before)) break;
		await page.click(`[data-jp-control="${roles.next.ref}"]`).catch(() => {});
		await page.waitForTimeout(500);
		const next = await scanOf(page);
		if (!next || next.fields.length === 0) break;
		scan = next;
		canSubmit ||= scan.canSubmit;
		// A later step that names another host as where it sends: the user finishes the form.
		const away = elsewhere(page, scan, formHost);
		if (away) return { ok: false, reason: away.message, handoff: true };
	}
	// Nothing on the form is known to send it (no submit button of its own, shown or kept for a
	// later step): the user finishes it (review shows why).
	if (!submit && !canSubmit)
		return {
			ok: false,
			reason: "This form has no submit button of its own; finish it yourself.",
			handoff: true,
		};
	const labelled = await modelLabels(
		fields.map((f) => f.field),
		model,
	);
	return {
		ok: true,
		schema: {
			board: "web",
			url,
			submit: submit?.text ?? null,
			formUrl: opened.formUrl,
			fields: fields.map(({ field, page: p }) => {
				const {
					hint: _h,
					autocomplete: _a,
					inputType: _t,
					step: _s,
					...rest
				} = field;
				const fromModel = labelled.get(field.ref);
				const label = fromModel ?? plainLabel(field);
				const out: WebSchemaField = {
					...rest,
					label,
					key: schemaKey(field),
					page: p,
					section: field.section ?? "",
					...(fromModel ? { labelSource: "model" as const } : {}),
				};
				return out;
			}),
		},
	};
}

/** Labels for the controls nothing names, chosen by the model from the page's own text. */
async function modelLabels(
	fields: WebField[],
	model: WebFormModel | null | undefined,
): Promise<Map<string, string>> {
	const unnamed = fields.filter(
		(f) => !plainLabel(f) && f.hint && systemRole(f) === null,
	);
	if (!model || unnamed.length === 0) return new Map();
	const candidates = [
		...new Set([...STANDARD_LABELS, ...unnamed.map((f) => f.hint)]),
	];
	const answers = await model
		.labels({
			fields: unnamed.map((f) => ({
				ref: f.ref,
				kind: f.kind,
				name: f.name,
				hint: f.hint,
			})),
			candidates,
		})
		.catch(() => []);
	return new Map(answers.map((a) => [a.ref, a.label]));
}

/* ---------------------------------------------------------------- filling */

interface Lined {
	fields: FormField[];
	/** Required questions on this step the reviewed list does not have. */
	unexpected: string[];
	/** Refs of optional questions the reviewed list does not have: at most emptied. */
	unreviewed: Set<string>;
	/** Refs on steps the page keeps hidden for now: filled when their step is shown. */
	later: Set<string>;
}

/**
 * The reviewed field each live control is, by ref: by its key alone (name, stable id or label,
 * `schemaKey`), each reviewed field once, in page order. Nothing else, not the model, lines a
 * control up with a reviewed field; a control with no key of its own never gets this far
 * (`unlabelledProblem`).
 */
function resolveAll(
	scanned: WebField[],
	byKey: Map<string, WebSchemaField>,
): Map<string, WebSchemaField> {
	const out = new Map<string, WebSchemaField>();
	const taken = new Set<string>();
	for (const field of scanned) {
		const reviewed = byKey.get(schemaKey(field));
		if (!reviewed || taken.has(reviewed.key)) continue;
		taken.add(reviewed.key);
		out.set(field.ref, reviewed);
	}
	return out;
}

/**
 * Lines the live controls up with the reviewed fields by key. Each lined-up control takes the
 * reviewed field's label and name, so the plan and the checks see the field review listed. A
 * control that lines up with none is a question review never listed: required, the run stops;
 * optional, it stays empty.
 */
function lineUp(scanned: WebField[], schema: WebSchemaField[]): Lined {
	const resolved = resolveAll(scanned, new Map(schema.map((f) => [f.key, f])));
	const unexpected: string[] = [];
	const unreviewed = new Set<string>();
	const fields = scanned.map((f): FormField => {
		const { hint: _h, autocomplete: _a, inputType: _t, step: _s, ...field } = f;
		const known = resolved.get(f.ref);
		if (!known) {
			if (f.visible && f.step === 1 && f.required && systemRole(f) !== "ignore")
				unexpected.push(f.label || f.hint || f.name);
			else unreviewed.add(f.ref);
			return field;
		}
		return {
			...field,
			label: known.label,
			name: known.name,
			options:
				f.kind === "combobox" && f.options.length === 0
					? known.options
					: f.options,
		};
	});
	const later = new Set(scanned.filter((f) => f.step !== 1).map((f) => f.ref));
	return { fields, unexpected, unreviewed, later };
}

/** What a filled field records: the file's name, the chosen options, or the value. */
function filledValue(action: FillAction, run: ApplicationRun): string {
	switch (action.kind) {
		case "file":
			return action.file === "cv"
				? run.files.cv.name
				: (run.files.coverLetter?.name ?? "");
		case "choose":
			return action.values.join("; ");
		case "clear":
			return "(left blank)";
		default:
			return action.value;
	}
}

/** The plan for the controls shown now: reviewed fields get their value; others are at most emptied. */
function stepPlan(
	lined: Lined,
	run: Pick<ApplicationRun, "data">,
): { plan: FillPlan; shown: FormField[] } {
	const shown = lined.fields.filter(
		(f) => f.visible && !lined.later.has(f.ref),
	);
	const planned = planFill(shown, run.data, {
		declineVoluntary: true,
		plainLocation: true,
	});
	return {
		shown,
		plan: {
			...planned,
			// A country the page derives from the phone is not something a generic form promises.
			actions: planned.actions.filter(
				(a) =>
					a.kind !== "expect" &&
					(!lined.unreviewed.has(a.ref) || a.kind === "clear"),
			),
		},
	};
}

type StepResult =
	| { ok: true; scan: WebScan; lined: Lined }
	| { ok: false; stop: Stop };

/**
 * Why the step shown now cannot be filled: a wall, a form that sends elsewhere, or controls that
 * no longer line up with the reviewed list. Null when it can.
 */
function stepProblem(
	page: BrowserPage,
	scan: WebScan,
	state: RunState,
	lined: Lined,
): Stop | null {
	const wall =
		wallOf(scan) ??
		elsewhere(page, scan, state.formHost) ??
		unlabelledProblem(scan.fields);
	if (wall) return wall;
	if (lined.unexpected.length > 0)
		return {
			kind: "form_changed",
			message: `The form now asks ${lined.unexpected.map((l) => `"${l}"`).join(", ")}, which was not in the approved list of what will be sent.`,
		};
	return null;
}

/** Records a filled control, and what the application request must carry (`carriesValues`). */
function recordFilled(
	state: RunState,
	action: FillAction,
	field: FormField,
	run: ApplicationRun,
): void {
	state.filled.push({
		label: action.label || field.name,
		value: filledValue(action, run),
	});
	if (action.kind === "fill" || action.kind === "location")
		state.sent.typed.push(action.value);
	if (action.kind === "file" && action.file === "cv")
		state.sent.cv = run.files.cv.name;
}

/** Fills the step shown now and checks it: every control holds its approved value or nothing. */
async function fillStep(
	page: BrowserPage,
	run: ApplicationRun,
	scan: WebScan,
	state: RunState,
): Promise<StepResult> {
	const lined = lineUp(scan.fields, state.schema);
	const problem = stepProblem(page, scan, state, lined);
	if (problem) return { ok: false, stop: problem };
	const { plan, shown } = stepPlan(lined, run);
	if (plan.unknown.length > 0)
		return {
			ok: false,
			stop: {
				kind: "unknown_questions",
				message: `${plan.unknown.length} required question(s) have no approved answer: ${plan.unknown.map((q) => `"${q.label}"`).join(", ")}.`,
				questions: plan.unknown,
			},
		};
	const byRef = new Map(shown.map((f) => [f.ref, f]));
	for (const action of plan.actions) {
		const field = byRef.get(action.ref);
		if (!field) continue;
		if (action.kind === "file" && !state.uploadsCleared) {
			const away = destinationProblem(page, run.allowedHosts);
			if (away)
				return { ok: false, stop: { kind: "other_site", message: away } };
			const refused = (await run.beforeUpload?.()) ?? null;
			if (refused)
				return { ok: false, stop: { kind: "error", message: refused } };
			state.uploadsCleared = true;
		}
		const stop = await perform(page, action, field, run.files);
		if (stop) return { ok: false, stop };
		recordFilled(state, action, field, run);
	}
	// An upload the page sent elsewhere is refused by the session and recorded: stop here.
	const refused = destinationProblem(page, run.allowedHosts);
	if (refused)
		return { ok: false, stop: { kind: "other_site", message: refused } };
	const again = await scanOf(page);
	if (!again)
		return {
			ok: false,
			stop: {
				kind: "unrecognized_page",
				message: "The form disappeared while filling.",
			},
		};
	// Filling may have pointed the form elsewhere: the claim never comes for that.
	const moved = elsewhere(page, again, state.formHost);
	if (moved) return { ok: false, stop: moved };
	const now = lineUp(again.fields, state.schema);
	const mismatches = verifyFilled(
		plan,
		shown,
		now.fields.filter((f) => f.visible && !now.later.has(f.ref)),
	);
	if (mismatches.length > 0)
		return {
			ok: false,
			stop: {
				kind: "validation",
				message: `The filled form does not match the approved answers: ${mismatches.join(" ")}`,
			},
		};
	if (again.errors.length > 0)
		return {
			ok: false,
			stop: {
				kind: "validation",
				message: `The form shows errors: ${again.errors.join(" | ")}`,
			},
		};
	const challenge = await challengeOf(page);
	if (challenge)
		return {
			ok: false,
			stop: {
				kind: "challenge",
				message: `${challenge} appeared while filling.`,
			},
		};
	return { ok: true, scan: again, lined: now };
}

/* --------------------------------------------------------------- outcome */

const plain = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** A URL's origin and path: a change of query or fragment alone is no new page. */
const pathOf = (url: string) => {
	try {
		const { origin, pathname } = new URL(url);
		return `${origin}${pathname}`;
	} catch {
		return url;
	}
};
const occurrences = (text: string, part: string) =>
	part ? text.split(part).length - 1 : 0;

/** The page just before the one click: its text, and how many requests had started by then. */
interface BeforeClick {
	text: string;
	started: number;
}

const NO_APPLICATION =
	"The page changed after the click, but no request carrying the application reached the employer's site.";
const isWrite = (r: { method: string }) => !/^(?:GET|HEAD)$/i.test(r.method);
const seqOf = (r: { seq?: number }) => r.seq ?? 0;

/** The application request, unless it was answered with an error. */
function answered(
	request: NetworkLogEntry,
): { request: NetworkLogEntry } | { unknown: string } {
	return answeredOk(request)
		? { request }
		: {
				unknown: `The page changed after the click, but the employer's site answered HTTP ${request.status ?? "nothing"} to the application.`,
			};
}

/** The requests to the form's host the guard let through, in the order they started. */
function toFormHost(page: BrowserPage, hosts: string[]): NetworkLogEntry[] {
	return page
		.networkLog()
		.filter(
			(r) =>
				r.allowed &&
				r.reason === "allowed host" &&
				r.seq !== undefined &&
				urlOnHosts(r.url, hosts),
		)
		.sort((a, b) => seqOf(a) - seqOf(b));
}

/**
 * The request the submit click itself started that is the application, or why there is none
 * (docs/decisions.md, 2026-11-09, step 6 third pass). Requests count by when they started
 * (`seq`), never by when they were answered; one started before the click never counts. A native
 * submission: the page's own navigation to the form's host, the first one started after the
 * click, when it posts or its query carries the values; it must carry every approved value
 * (`carriesValues`). Else a script's: exactly one request to the form's host that is not a read,
 * started after the click and before the next navigation, carrying every approved value, with no
 * other request to the form's host carrying them (before the click or after) and none still
 * unanswered. Anything else is no evidence: an unknown outcome.
 */
function applicationRequest(
	page: BrowserPage,
	before: BeforeClick,
	run: ApplicationRun,
	state: RunState,
): { request: NetworkLogEntry } | { unknown: string } {
	const hosts = run.allowedHosts ?? [state.formHost];
	const all = toFormHost(page, hosts);
	const carries = (r: NetworkLogEntry) => carriesValues(r, state.sent);
	const navigation = all.find((r) => seqOf(r) > before.started && r.navigation);
	if (navigation && (isWrite(navigation) || carries(navigation)))
		return carries(navigation)
			? answered(navigation)
			: { unknown: NO_APPLICATION };
	const until = navigation ? seqOf(navigation) : Number.POSITIVE_INFINITY;
	const scripted = (r: { seq?: number; url: string; method: string }) =>
		seqOf(r) > before.started && seqOf(r) < until && isWrite(r);
	// A request is logged a moment before it leaves the pending set: logged is answered.
	const logged = new Set(all.map(seqOf));
	const unanswered = page
		.networkStarted()
		.pending.filter(
			(p) => !logged.has(p.seq) && scripted(p) && urlOnHosts(p.url, hosts),
		);
	if (unanswered.length > 0)
		return {
			unknown: `The page changed after the click, but ${unanswered.length} request(s) it started to the employer's site had no answer yet, so which one was the application cannot be told.`,
		};
	const sent = all.filter((r) => scripted(r) && !r.navigation);
	if (sent.length > 1)
		return {
			unknown: `The page changed after the click, but it sent ${sent.length} requests to the employer's site, so which one was the application cannot be told.`,
		};
	const request = sent[0];
	if (!request || !carries(request)) return { unknown: NO_APPLICATION };
	if (all.some((r) => r !== request && carries(r)))
		return {
			unknown:
				"The page changed after the click, but another request to the employer's site carried the same answers, so which one was the application cannot be told.",
		};
	return answered(request);
}

/**
 * After the one click: waits for evidence (the application request the click started reached the
 * form's host, `applicationRequest`, and the form is gone or the page's path changed), then checks
 * that neither the page nor the employer's answer says anything went wrong (`refusalAfter`), then
 * the model reads the page. Only "confirmed", backed by all of that and a quote found on the page
 * in confirmation words that were not on it before the click, records it applied; anything else
 * is an unknown outcome, never a retry.
 */
async function readOutcome(
	page: BrowserPage,
	formUrl: string,
	run: ApplicationRun,
	before: BeforeClick,
	state: RunState,
): Promise<{ confirmed: string } | { unknown: string }> {
	const changed = await awaitChange(page, formUrl, run);
	if ("unknown" in changed) return changed;
	const sent = applicationRequest(page, before, run, state);
	if ("unknown" in sent) return sent;
	const refused = refusalAfter(changed.after, sent.request);
	if (refused) return { unknown: refused };
	return judge(changed.after, formUrl, run.model, before);
}

/** Polls until the page's path changed or the form is gone; an unknown outcome when it never does. */
async function awaitChange(
	page: BrowserPage,
	formUrl: string,
	run: ApplicationRun,
): Promise<{ after: WebAfter } | { unknown: string }> {
	const timeoutMs = run.confirmTimeoutMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	let after: WebAfter | null = null;
	while (Date.now() < deadline) {
		await page.waitForTimeout(400);
		const away = destinationProblem(page, run.allowedHosts);
		if (away) return { unknown: away };
		const challenge = await challengeOf(page);
		if (challenge) return { unknown: `${challenge} appeared after the click.` };
		after = (await safeEvaluate<WebAfter>(page, WEB_AFTER_SCRIPT)) ?? after;
		if (after && (pathOf(after.url) !== pathOf(formUrl) || !after.formShown)) {
			await page.waitForNetworkIdle(3_000);
			return {
				after: (await safeEvaluate<WebAfter>(page, WEB_AFTER_SCRIPT)) ?? after,
			};
		}
	}
	return {
		unknown: after?.errors.length
			? `The form showed errors after the click: ${after.errors.join(" | ")}`
			: `No confirmation within ${Math.round(timeoutMs / 1000)}s: the form is still on the page.`,
	};
}

/**
 * True when the quote is the page's own new confirmation: on the page now, in confirmation
 * words, and neither the quote nor those words were on the page before the click.
 */
function newConfirmation(
	quote: string,
	after: WebAfter,
	before: BeforeClick,
): boolean {
	const said = plain(quote);
	const now = plain(after.text);
	const was = plain(before.text);
	const words = plain(said.match(CONFIRMED)?.[0] ?? "");
	return (
		said.length > 0 &&
		now.includes(said) &&
		!was.includes(said) &&
		words.length > 0 &&
		occurrences(now, words) > occurrences(was, words)
	);
}

/**
 * Why the page after the click, or the HTML the application request was answered with, may
 * say it did not go through: refusal or error wording anywhere in either (`refusalIn`), or a
 * visible error or field marked invalid. Null when neither does.
 */
function refusalAfter(
	after: WebAfter,
	request: NetworkLogEntry,
): string | null {
	if (after.errors.length > 0)
		return `The form showed errors after the click: ${after.errors.join(" | ")}`;
	const shown = refusalIn(after.text);
	if (shown)
		return `The page after the click says "${shown}", so the application may not have gone through.`;
	const inAnswer = request.answerHtml
		? refusalIn(htmlText(request.answerHtml))
		: null;
	return inAnswer
		? `The employer's answer to the application says "${inAnswer}", so it may not have gone through.`
		: null;
}

/** The model's reading of the changed page, believed only where the page bears it out. */
async function judge(
	after: WebAfter,
	formUrl: string,
	model: WebFormModel | null | undefined,
	before: BeforeClick,
): Promise<{ confirmed: string } | { unknown: string }> {
	const urlChanged = pathOf(after.url) !== pathOf(formUrl);
	if (!model)
		return {
			unknown:
				"The page changed after the click, but no model was available to read it.",
		};
	const read = await model
		.outcome({
			title: after.title,
			text: after.text.slice(0, 6000),
			urlChanged,
			formGone: !after.formShown,
		})
		.catch(() => null);
	if (!read)
		return {
			unknown:
				"The page changed after the click, but the model could not read it.",
		};
	const quote = read.quote.trim();
	if (read.verdict === "error")
		return {
			unknown: `The page after the click shows an error${quote ? `: "${quote}"` : "."}`,
		};
	if (read.verdict === "unclear")
		return {
			unknown: `The page after the click does not say the application was received${quote ? `: "${quote}"` : "."}`,
		};
	const supported = newConfirmation(quote, after, before);
	return supported
		? { confirmed: quote }
		: {
				unknown: `The model read a confirmation the page does not bear out${quote ? ` ("${quote.slice(0, 200)}")` : ""}.`,
			};
}

/* ------------------------------------------------------------------- run */

function stopped(
	stop: Stop,
	screenshot: Uint8Array | null,
	filled: FilledField[],
	steps: Uint8Array[] = [],
): RunResult {
	return {
		outcome: "stopped",
		stop,
		screenshot,
		filled,
		...(steps.length > 0 ? { steps } : {}),
	};
}

/** A filled step's screenshot, kept for the proof before its "Next" is clicked. */
async function keepStepShot(page: BrowserPage, shots: Uint8Array[]) {
	const bytes = await shot(page);
	if (bytes) shots.push(bytes);
}

interface RunState {
	schema: WebSchemaField[];
	/** The exact host of the form's page: the only one the application may go to. */
	formHost: string;
	/** The approved values filled in so far: what the application request must carry. */
	sent: SentValues;
	filled: FilledField[];
	uploadsCleared: boolean;
	/** The latest screenshot before a click that may send data. */
	before: Uint8Array | null;
	/** True once the claim agreed: from then on every end is an unknown outcome. */
	claimed: boolean;
	/** A multi-step form: a screenshot of each filled step before its "Next" (proof, step 7). */
	steps: Uint8Array[];
}

/** The run's step screenshots, when it took any (`RunResult.steps`). */
const stepsOf = (state: RunState) =>
	state.steps.length > 0 ? { steps: state.steps } : {};

/** After the claim, any end but the outcome reader's: unknown, never "nothing was sent". */
async function unknownAfterClaim(
	page: BrowserPage,
	state: RunState,
	reason: string,
): Promise<RunResult> {
	const after = await shot(page);
	return {
		outcome: "unknown",
		before: state.before ?? after ?? new Uint8Array(),
		after,
		reason,
		finalUrl: page.url(),
		filled: state.filled,
		...stepsOf(state),
	};
}

/** A stop: before the claim nothing was sent; after it, the outcome is unknown. */
async function ended(
	page: BrowserPage,
	state: RunState,
	stop: Stop,
): Promise<RunResult> {
	if (!state.claimed)
		return stopped(stop, await shot(page), state.filled, state.steps);
	return unknownAfterClaim(
		page,
		state,
		`${stop.message} This was after the form's "Next" was clicked, so the employer's site may already hold some answers.`,
	);
}

/**
 * The gate before any click that may send data ("Next" or the submit, submit mode only): the page
 * is still on the form's hosts with the control clickable; then the claim the first time, and the
 * pause switch every later time. A result ends the run; null lets the click happen.
 */
async function beforeSending(
	page: BrowserPage,
	run: ApplicationRun,
	state: RunState,
	control: WebControl,
): Promise<RunResult | null> {
	const away = destinationProblem(page, run.allowedHosts);
	const covered = await safeEvaluate<string | null>(
		page,
		webCoveredScript(control.ref),
	);
	state.before = (await shot(page)) ?? state.before;
	if (away || covered)
		return ended(page, state, {
			kind: away ? "other_site" : "unrecognized_page",
			message: away ?? (covered as string),
		});
	if (state.claimed) {
		const paused = (await run.beforeStep?.()) ?? null;
		return paused
			? ended(page, state, { kind: "error", message: paused })
			: null;
	}
	const claimed = run.claim
		? await run.claim(state.before ?? new Uint8Array(), state.filled)
		: ({ go: false, reason: "no claim gate" } as const);
	if (!claimed.go)
		return {
			outcome: "not_claimed",
			reason: claimed.reason,
			screenshot: state.before ?? new Uint8Array(),
			filled: state.filled,
			...stepsOf(state),
		};
	state.claimed = true;
	return null;
}

/**
 * Steps through the form, filling each, up to the final submit control (not clicked here). In a
 * submission the first "Next" waits for the claim (`beforeSending`): a step may send answers.
 */
async function fillSteps(
	page: BrowserPage,
	run: ApplicationRun,
	first: WebScan,
	state: RunState,
): Promise<
	| { ok: true; submit: WebControl }
	| { ok: false; stop: Stop }
	| { ok: false; result: RunResult }
> {
	const lastPage = state.schema.reduce((m, f) => Math.max(m, f.page), 1);
	let scan = first;
	for (let step = 1; step <= MAX_STEPS; step++) {
		const done = await fillStep(page, run, scan, state);
		if (!done.ok) return done;
		const roles = await controlRoles(done.scan.controls, run.model);
		// "Next" only while the reviewed form has a later step: otherwise any control that may send
		// is the final submit, clicked once after the claim.
		if (roles.next && step < lastPage) {
			const gate =
				run.mode === "submit"
					? await beforeSending(page, run, state, roles.next)
					: null;
			if (gate) return { ok: false, result: gate };
			// The step as filled, for the proof (step 7); a screenshot sends nothing.
			await keepStepShot(page, state.steps);
			await page.click(`[data-jp-control="${roles.next.ref}"]`);
			await page.waitForTimeout(500);
			await page.waitForNetworkIdle(5_000);
			const away = destinationProblem(page, run.allowedHosts);
			if (away)
				return { ok: false, stop: { kind: "other_site", message: away } };
			const next = await scanOf(page);
			if (!next || next.fields.length === 0)
				return {
					ok: false,
					stop: {
						kind: "unrecognized_page",
						message: `Step ${step + 1} of the form showed no questions.`,
					},
				};
			scan = next;
			continue;
		}
		if (!roles.submit)
			return {
				ok: false,
				stop: {
					kind: "unrecognized_page",
					message: `Could not tell which control sends the application (${done.scan.controls.map((c) => `"${c.text}"`).join(", ") || "none"}); nothing more was clicked.`,
				},
			};
		return { ok: true, submit: roles.submit };
	}
	return {
		ok: false,
		stop: {
			kind: "unrecognized_page",
			message: `The form has more than ${MAX_STEPS} steps.`,
		},
	};
}

/** Clicks the final submit once and reads the outcome; never throws. */
async function submitOnce(
	page: BrowserPage,
	run: ApplicationRun,
	state: RunState,
	submit: WebControl,
): Promise<RunResult> {
	const formUrl = page.url();
	const before = state.before ?? new Uint8Array();
	try {
		const beforeClick = {
			text: (await safeEvaluate<string>(page, PAGE_TEXT_SCRIPT)) ?? "",
			// Read last, just before the click: the click started every request after this count.
			started: page.networkStarted().count,
		};
		await page.click(`[data-jp-control="${submit.ref}"]`);
		const result = await readOutcome(page, formUrl, run, beforeClick, state);
		const after = (await shot(page)) ?? new Uint8Array();
		return "confirmed" in result
			? {
					outcome: "submitted",
					before,
					after,
					confirmation: result.confirmed,
					finalUrl: page.url(),
					filled: state.filled,
					...stepsOf(state),
				}
			: {
					outcome: "unknown",
					before,
					after,
					reason: result.unknown,
					finalUrl: page.url(),
					filled: state.filled,
					...stepsOf(state),
				};
	} catch (error) {
		return unknownAfterClaim(
			page,
			state,
			`Error after the submit click: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** A dry run's end: the filled form, short of the submit. */
async function dryRunEnd(
	page: BrowserPage,
	run: ApplicationRun,
	state: RunState,
	submit: WebControl,
): Promise<RunResult> {
	const before = await page.screenshot({ fullPage: true });
	const away = destinationProblem(page, run.allowedHosts);
	const covered = await safeEvaluate<string | null>(
		page,
		webCoveredScript(submit.ref),
	);
	if (away || covered)
		return stopped(
			{
				kind: away ? "other_site" : "unrecognized_page",
				message: away ?? (covered as string),
			},
			before,
			state.filled,
			state.steps,
		);
	return {
		outcome: "dry_run",
		screenshot: before,
		filled: state.filled,
		blank: [],
		...stepsOf(state),
	};
}

/**
 * One run on an employer's form: open, fill each step from the approved plan, screenshot, and
 * (submit mode) click the final submit once and read the outcome. The claim comes before the
 * first click that may send data: the first "Next" of a multi-step form, else the submit. After
 * it nothing is ever "not sent": every end is an unknown outcome. Never throws.
 */
export async function runWebApplication(
	page: BrowserPage,
	run: ApplicationRun,
): Promise<RunResult> {
	const state: RunState = {
		schema: (run.schema ?? []) as WebSchemaField[],
		formHost: webFormHost(run.url),
		sent: { typed: [], cv: null },
		filled: [],
		uploadsCleared: false,
		before: null,
		claimed: false,
		steps: [],
	};
	try {
		if (!run.schema)
			return stopped(
				{
					kind: "form_changed",
					message:
						"The employer's form was not read before review, so nothing on it was approved.",
				},
				null,
				[],
			);
		// A read saved before unlabelled fields became a hand-off: still never filled by place.
		if (run.schema.some((f) => f.name.startsWith("#")))
			return stopped(UNLABELLED, null, []);
		const opened = await openWebForm(page, run.url, run.allowedHosts);
		if ("stop" in opened) return stopped(opened.stop, await shot(page), []);
		state.formHost = webFormHost(opened.formUrl);
		// Every reviewed question on every step must have its approved value before the first one.
		const whole = planFill(run.schema, run.data, {
			declineVoluntary: true,
			plainLocation: true,
		});
		if (whole.unknown.length > 0)
			return stopped(
				{
					kind: "unknown_questions",
					message: `${whole.unknown.length} required question(s) have no approved answer: ${whole.unknown.map((q) => `"${q.label}"`).join(", ")}.`,
					questions: whole.unknown,
				},
				await shot(page),
				[],
			);
		// Before the first keystroke: a submission fixes the files other hosts may serve.
		page.freezeAssets();
		run.beforeFill?.();
		const steps = await fillSteps(page, run, opened.scan, state);
		if (!steps.ok)
			return "result" in steps
				? steps.result
				: await ended(page, state, steps.stop);
		if (run.mode === "dry_run")
			return await dryRunEnd(page, run, state, steps.submit);
		const gate = await beforeSending(page, run, state, steps.submit);
		if (gate) return gate;
		return await submitOnce(page, run, state, steps.submit);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (state.claimed)
			return unknownAfterClaim(page, state, `Error: ${message}`);
		const away = destinationProblem(page, run.allowedHosts);
		return stopped(
			{
				kind: away ? "other_site" : "error",
				message: `${away ?? message} (before submitting; nothing was sent)`,
			},
			await shot(page),
			state.filled,
			state.steps,
		);
	}
}
