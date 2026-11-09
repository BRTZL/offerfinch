import type { BrowserPage } from "../scrape/browser";
import {
	type ApplicationRun,
	destinationProblem,
	type FilledField,
	perform,
	type RunResult,
	type Stop,
} from "./applier";
import { type FormSchema, type SchemaField, schemaKey } from "./form-schema";
import {
	DUPLICATE,
	type FillAction,
	type FillPlan,
	type FormField,
	optionsScript,
	planFill,
	questionKeyOf,
	REFUSAL,
	systemRole,
	VISIBLE_CHALLENGE_SCRIPT,
	verifyFilled,
} from "./forms";
import { sameSite } from "./web-hosts";
import type { ControlRole, WebFormModel } from "./web-model";
import {
	WEB_AFTER_SCRIPT,
	WEB_SCAN_SCRIPT,
	type WebAfter,
	type WebControl,
	type WebField,
	type WebScan,
	webCoveredScript,
} from "./web-scan";

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
	/** A control keyed by its place (`#text-1`): the text beside it and its autocomplete token. */
	hint?: string;
	autocomplete?: string;
	/** A place key the read met twice with different text beside it: never trusted at submit. */
	ambiguous?: true;
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

/**
 * Opens an employer's form; a stop when the page is blocked, a challenge, a wall, on another
 * site, or shows no form. A form in a frame of the same site is opened on its own.
 */
export async function openWebForm(
	page: BrowserPage,
	url: string,
	allowedHosts?: string[],
): Promise<{ scan: WebScan } | { stop: Stop }> {
	const nav = await page.goto(url, { waitUntil: "load", timeoutMs: 45_000 });
	if (nav.status !== null && BLOCK_STATUSES.has(nav.status))
		return {
			stop: {
				kind: "challenge",
				message: `The site answered HTTP ${nav.status}.`,
			},
		};
	let found = await awaitForm(page, allowedHosts, 15_000);
	if ("stop" in found) return found;
	const frame = found.scan.frameUrl;
	if (frame) {
		const here = new URL(page.url()).hostname;
		const there = new URL(frame, page.url());
		if (!sameSite(here, there.hostname))
			return {
				stop: {
					kind: "other_site",
					message: `The application form is in a frame from ${there.host}, another site than ${here}.`,
				},
			};
		await page.goto(there.href, { waitUntil: "load", timeoutMs: 45_000 });
		found = await awaitForm(page, allowedHosts, 15_000);
		if ("stop" in found) return found;
	}
	const { scan } = found;
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
	return { scan };
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
 * The controls with deterministic evidence that they send the form: a submit button of the form
 * (`<button>` without another type, `<input type=submit>`), or, on a form that sends by script,
 * its only plain button whose words say submit. Only these can ever be the submit.
 */
function submitCapable(controls: WebControl[]): Set<string> {
	const worded = controls.filter(
		(c) => c.type === "button" && wordsRole(c) === "submit",
	);
	return new Set(
		controls
			.filter(
				(c) =>
					(c.type === "submit" && wordsRole(c) !== "other") ||
					(worded.length === 1 && c === worded[0]),
			)
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

/**
 * Reads an employer's form on a page whose session is read-only, closing the network after the
 * first scan. Steps the page keeps hidden are read as later pages; steps it draws only after
 * "Next" are reached by clicking "Next" with the network closed and nothing typed, as far as the
 * form lets it. A control the page names nothing for is labelled by the model from the page's own
 * text, or left without a label.
 */
export async function readWebFormOnPage(
	page: BrowserPage,
	url: string,
	model?: WebFormModel | null,
): Promise<{ ok: true; schema: FormSchema } | { ok: false; reason: string }> {
	const opened = await openWebForm(page, url);
	if ("stop" in opened) return { ok: false, reason: opened.stop.message };
	page.restrictNetwork("none");
	const fields: { field: WebField; page: number }[] = [];
	const keys = new Map<string, WebField>();
	const ambiguous = new Set<string>();
	let scan = opened.scan;
	let submit: WebControl | null = null;
	for (let step = 1; step <= MAX_STEPS; step++) {
		await readComboboxes(page, scan.fields);
		const before = fields.length;
		const last = fields.reduce((m, f) => Math.max(m, f.page), 0);
		for (const field of scan.fields) {
			const key = schemaKey(field);
			const seen = keys.get(key);
			if (seen) {
				// A step drawn after "Next" counts its unlabelled boxes from 1 again.
				if (placed(field) && !sameSpot(field, seen)) ambiguous.add(key);
				continue;
			}
			keys.set(key, field);
			// Hidden steps count after the one shown; a step drawn after "Next" follows the last read.
			fields.push({ field, page: step === 1 ? field.step : last + 1 });
		}
		const roles = await controlRoles(scan.controls, model);
		submit = roles.submit ?? submit;
		if (!roles.next || (step > 1 && fields.length === before)) break;
		await page.click(`[data-jp-control="${roles.next.ref}"]`).catch(() => {});
		await page.waitForTimeout(500);
		const next = await scanOf(page);
		if (!next || next.fields.length === 0) break;
		scan = next;
	}
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
					...(placed(field)
						? { hint: field.hint, autocomplete: field.autocomplete }
						: {}),
					...(ambiguous.has(schemaKey(field))
						? { ambiguous: true as const }
						: {}),
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
	/** Unlabelled controls whose places no longer match the read (`placesMoved`). */
	moved: string[];
}

/** The text beside an unlabelled control and its autocomplete token: what its place key must match. */
const sameSpot = (
	live: WebField,
	reviewed: { hint?: string; autocomplete?: string },
) =>
	questionKeyOf(live.hint) === questionKeyOf(reviewed.hint ?? "") &&
	live.autocomplete === (reviewed.autocomplete ?? "");

const placed = (f: { name: string }) => f.name.startsWith("#");
/** Unlabelled controls of one kind with the same text beside them: a place key counts within one. */
const groupOf = (f: { kind: string; hint?: string }) =>
	`${f.kind}|${questionKeyOf(f.hint ?? "")}`;
const placeOf = (f: { name: string; autocomplete?: string }) =>
	`${f.name}|${f.autocomplete ?? ""}`;

/**
 * Where a key that is only a place (`#text-2`) can no longer be trusted: a group of unlabelled
 * controls (same kind, same text beside them) the read saw whose places, in order, are not the
 * ones the live page shows (a box added, removed or moved in the group or before it), or a place
 * the read saw twice with different text beside it. The run stops on any (form_changed).
 */
function placesMoved(scanned: WebField[], schema: WebSchemaField[]): string[] {
	const groups = (fields: (WebField | WebSchemaField)[]) => {
		const out = new Map<string, string[]>();
		for (const f of fields.filter(placed))
			out.set(groupOf(f), [...(out.get(groupOf(f)) ?? []), placeOf(f)]);
		return out;
	};
	const reviewed = groups(schema);
	const moved: string[] = [];
	for (const [group, places] of groups(scanned)) {
		const was = reviewed.get(group);
		const field = scanned.find((f) => placed(f) && groupOf(f) === group);
		const ambiguous = schema.some(
			(f) => f.ambiguous && places.some((p) => p === placeOf(f)),
		);
		if ((was && was.join() !== places.join()) || ambiguous)
			moved.push(field?.hint || field?.kind || group);
	}
	return moved;
}

/**
 * The reviewed field each live control is, by ref: by its key alone (name, stable id or label,
 * `schemaKey`), each reviewed field once, in page order. Nothing else, not the model, lines a
 * control up with a reviewed field. A key that is only a place among unlabelled controls
 * (`#text-2`) counts only when the text beside the control is the one review saw, so a box the
 * page added never takes another question's value.
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
		if (reviewed.name.startsWith("#") && !sameSpot(field, reviewed)) continue;
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
	const moved = placesMoved(scanned, schema);
	return { fields, unexpected, unreviewed, later, moved };
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

/** Fills the step shown now and checks it: every control holds its approved value or nothing. */
async function fillStep(
	page: BrowserPage,
	run: ApplicationRun,
	scan: WebScan,
	state: {
		schema: WebSchemaField[];
		filled: FilledField[];
		uploadsCleared: boolean;
	},
): Promise<StepResult> {
	const wall = wallOf(scan);
	if (wall) return { ok: false, stop: wall };
	const lined = lineUp(scan.fields, state.schema);
	if (lined.moved.length > 0)
		return {
			ok: false,
			stop: {
				kind: "form_changed",
				message: `The form's unlabelled boxes (${lined.moved.map((l) => `"${l}"`).join(", ")}) are not where review saw them, so which box is which can no longer be told.`,
			},
		};
	if (lined.unexpected.length > 0)
		return {
			ok: false,
			stop: {
				kind: "form_changed",
				message: `The form now asks ${lined.unexpected.map((l) => `"${l}"`).join(", ")}, which was not in the approved list of what will be sent.`,
			},
		};
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
		state.filled.push({
			label: action.label || field.name,
			value: filledValue(action, run),
		});
	}
	// An upload the page sent elsewhere is refused by the session and recorded: stop here.
	const away = destinationProblem(page, run.allowedHosts);
	if (away) return { ok: false, stop: { kind: "other_site", message: away } };
	const again = await scanOf(page);
	if (!again)
		return {
			ok: false,
			stop: {
				kind: "unrecognized_page",
				message: "The form disappeared while filling.",
			},
		};
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
const withoutHash = (url: string) => url.replace(/#.*$/, "");

/**
 * After the one click: waits for evidence (the URL changed, or the form is gone), then the model
 * reads the page. Only "confirmed", backed by that evidence, a quote found on the page in
 * confirmation words, no refusal or duplicate wording and no visible error, records it applied;
 * anything else is an unknown outcome, never a retry.
 */
async function readOutcome(
	page: BrowserPage,
	formUrl: string,
	run: ApplicationRun,
): Promise<{ confirmed: string } | { unknown: string }> {
	const changed = await awaitChange(page, formUrl, run);
	if ("unknown" in changed) return changed;
	return judge(changed.after, formUrl, run.model);
}

/** Polls until the URL changed or the form is gone; an unknown outcome when it never does. */
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
		if (
			after &&
			(withoutHash(after.url) !== withoutHash(formUrl) || !after.formShown)
		) {
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

/** The model's reading of the changed page, believed only where the page bears it out. */
async function judge(
	after: WebAfter,
	formUrl: string,
	model: WebFormModel | null | undefined,
): Promise<{ confirmed: string } | { unknown: string }> {
	const urlChanged = withoutHash(after.url) !== withoutHash(formUrl);
	if (!model)
		return {
			unknown:
				"The page changed after the click, but no model was available to read it.",
		};
	const read = await model
		.outcome({
			title: after.title,
			text: after.text,
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
	const supported =
		quote.length > 0 &&
		plain(after.text).includes(plain(quote)) &&
		CONFIRMED.test(quote) &&
		!new RegExp(REFUSAL, "i").test(quote) &&
		!new RegExp(DUPLICATE, "i").test(after.text) &&
		after.errors.length === 0;
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
): RunResult {
	return { outcome: "stopped", stop, screenshot, filled };
}

/** Steps through the form, filling each, up to the final submit control (not clicked here). */
async function fillSteps(
	page: BrowserPage,
	run: ApplicationRun,
	first: WebScan,
	state: Parameters<typeof fillStep>[3],
): Promise<{ ok: true; submit: WebControl } | { ok: false; stop: Stop }> {
	const lastPage = state.schema.reduce((m, f) => Math.max(m, f.page), 1);
	let scan = first;
	let stepped = false;
	for (let step = 1; step <= MAX_STEPS; step++) {
		const done = await fillStep(page, run, scan, state);
		if (!done.ok) return done;
		const roles = await controlRoles(done.scan.controls, run.model);
		// "Next" only while the reviewed form has a later step: otherwise any control that may send
		// is the final submit, clicked once after the claim.
		if (roles.next && step < lastPage) {
			if (!stepped) {
				const refused = (await run.beforeStep?.()) ?? null;
				if (refused)
					return { ok: false, stop: { kind: "error", message: refused } };
				stepped = true;
			}
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
					message: `Could not tell which control sends the application (${done.scan.controls.map((c) => `"${c.text}"`).join(", ") || "none"}); nothing was clicked.`,
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

/**
 * One run on an employer's form: open, fill each step from the approved plan, screenshot, and
 * (submit mode, after the claim) click the final submit once and read the outcome. Never throws
 * after the click: errors become `unknown`.
 */
export async function runWebApplication(
	page: BrowserPage,
	run: ApplicationRun,
): Promise<RunResult> {
	const state = {
		schema: (run.schema ?? []) as WebSchemaField[],
		filled: [] as FilledField[],
		uploadsCleared: false,
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
		const opened = await openWebForm(page, run.url, run.allowedHosts);
		if ("stop" in opened) return stopped(opened.stop, await shot(page), []);
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
		run.beforeFill?.();
		const steps = await fillSteps(page, run, opened.scan, state);
		if (!steps.ok) return stopped(steps.stop, await shot(page), state.filled);
		const before = await page.screenshot({ fullPage: true });
		const away = destinationProblem(page, run.allowedHosts);
		const covered = await safeEvaluate<string | null>(
			page,
			webCoveredScript(steps.submit.ref),
		);
		if (away || covered)
			return stopped(
				{
					kind: away ? "other_site" : "unrecognized_page",
					message: away ?? (covered as string),
				},
				before,
				state.filled,
			);
		if (run.mode === "dry_run")
			return {
				outcome: "dry_run",
				screenshot: before,
				filled: state.filled,
				blank: [],
			};
		const claimed = run.claim
			? await run.claim(before, state.filled)
			: ({ go: false, reason: "no claim gate" } as const);
		if (!claimed.go)
			return {
				outcome: "not_claimed",
				reason: claimed.reason,
				screenshot: before,
				filled: state.filled,
			};
		const formUrl = page.url();
		try {
			await page.click(`[data-jp-control="${steps.submit.ref}"]`);
			const result = await readOutcome(page, formUrl, run);
			const after = (await shot(page)) ?? new Uint8Array();
			return "confirmed" in result
				? {
						outcome: "submitted",
						before,
						after,
						confirmation: result.confirmed,
						finalUrl: page.url(),
						filled: state.filled,
					}
				: {
						outcome: "unknown",
						before,
						after,
						reason: result.unknown,
						finalUrl: page.url(),
						filled: state.filled,
					};
		} catch (error) {
			return {
				outcome: "unknown",
				before,
				after: await shot(page),
				reason: `Error after the submit click: ${error instanceof Error ? error.message : String(error)}`,
				finalUrl: page.url(),
				filled: state.filled,
			};
		}
	} catch (error) {
		const away = destinationProblem(page, run.allowedHosts);
		return stopped(
			{
				kind: away ? "other_site" : "error",
				message: `${away ?? (error instanceof Error ? error.message : String(error))} (before submitting; nothing was sent)`,
			},
			await shot(page),
			state.filled,
		);
	}
}
