import { normalizeForMatch } from "../tailor/profile-rules";
import type { Contact, FormAnswer } from "../tailor/tailor";
import { BOARD_HOST_RULES, joinRules } from "./host-rules";
import type { HostRules } from "./network-guard";

/**
 * What the applier knows about each board's hosted application form, from the read-only
 * inspection in docs/form-inspection.md, and how answers are matched to its fields. Nothing here
 * guesses: a field gets a value only from the contact details, the approved form answers or the
 * approved documents; anything else required is an unknown question.
 */

export const BOARDS = [
	"ashby",
	"greenhouse",
	"lever",
	"workable",
	"recruitee",
	"teamtailor",
	"personio",
] as const;
export type Board = (typeof BOARDS)[number];

export interface BoardConfig {
	board: Board;
	/** The form; its absence means the page is not the form we expect. */
	root: string;
	/** One question per container: a label and its controls. */
	container: string;
	/** The question's label inside a container. */
	label: string;
	submit: string;
	/**
	 * The board's confirmation after a submit. `path` maps the form's path to the exact path the
	 * board moves to (none: the confirmation replaces the form on the same page); `selector` is
	 * where the confirmation text must be; `text` is what it says. Text alone never confirms: a
	 * board with neither `path` nor `selector` (its confirmation not yet seen) ends every
	 * submission as an unknown outcome. `refused` is the board's own "already applied" state.
	 */
	success: {
		path?: (formPath: string) => string;
		text: string;
		selector?: string;
		refused?: string;
	};
	/** Visible validation errors. */
	errors: string;
	/**
	 * Hosts besides the form's own that serve the form's files (scripts, styles, fonts, images),
	 * from the live inspection. A real submission's session may load those files from them (GET,
	 * HEAD; no xhr or fetch) with no query string, unless the board's rules list its parameters;
	 * its scoring widget's frames and endpoints are in `BOARD_HOST_RULES` (host-rules.ts). No
	 * request to them may carry a filled value. Employers' trackers are never listed.
	 */
	hosts?: readonly string[];
	/**
	 * The board's own hosts besides the form's that receive the application's data (uploads, a
	 * lookup of the typed email): any method, like the allowed form hosts.
	 */
	formHosts?: readonly string[];
	/** How this board's markup differs from the first three boards' (docs/form-inspection.md). */
	scan?: {
		/** Attribute that names a control without a `name` (its id changes on every load). */
		nameAttr?: string;
		/** Radios and checkboxes the board draws itself and hides from assistive tech are questions. */
		hiddenChoices?: boolean;
		/** Label text that is not part of the question ("Required", "(Optional)"), as a pattern. */
		labelNoise?: string;
		/** A question's container text that marks it required, as a pattern. */
		requiredText?: string;
		/** Controls marked required only by a style (an asterisk drawn in CSS), by name. */
		requiredNames?: string[];
		/** Where a file input's container lists the files chosen, when the input itself is emptied. */
		attachedFiles?: string;
	};
	/**
	 * The board's own cookie banner, when it covers the form: its "decline all" button, clicked
	 * once before filling. Only ever the decline; an employer's own banner is never touched.
	 */
	declineCookies?: string;
	/** The form's location box is plain text, not Lever's lookup that must resolve to a suggestion. */
	plainLocation?: boolean;
}

/** Label words the newer boards add around the question. */
const LABEL_NOISE =
	"\\((?:required|optional)\\)|^required\\.\\s*|^required(?=\\s|$)|\\s\\brequired\\.?$|svgs not supported by this browser\\.?|choose file|replace file";

export const BOARD_CONFIGS: Record<Board, BoardConfig> = {
	ashby: {
		board: "ashby",
		root: ".ashby-application-form-container",
		// The EEO radio groups (since 2026-11) are fieldsets of their own, outside any field entry.
		container:
			".ashby-application-form-field-entry, .ashby-application-form-input-radio-group",
		label: ".ashby-application-form-question-title",
		submit: "button.ashby-application-form-submit-button",
		success: {
			text: "thank you for applying|application (?:was |has been )?(?:submitted|received)|we(?:'ve| have) received your application",
			selector: ".ashby-application-form-success-container",
		},
		errors:
			".ashby-application-form-field-entry [class*='error' i]:not(:empty), [role=alert]:not(:empty)",
		// Seen on a live posting, 2026-11-09 (docs/form-inspection.md).
		hosts: [
			"app.ashbyhq.com",
			"cdn.ashbyprd.com",
			"fonts.googleapis.com",
			"fonts.gstatic.com",
			"www.gstatic.com",
		],
	},
	greenhouse: {
		board: "greenhouse",
		root: "form.application--form, form#application-form",
		container: ".field-wrapper, fieldset",
		label: "label, legend, .upload-label",
		submit: "form button[type=submit]",
		success: {
			path: (formPath) => `${formPath.replace(/\/+$/, "")}/confirmation`,
			text: "thank you for applying|application (?:has been |was )?(?:submitted|received)",
		},
		errors:
			".error-message:not(:empty), .helper-text--error:not(:empty), [role=alert]:not(:empty)",
		hosts: [
			"job-boards.cdn.greenhouse.io",
			"s2-recruiting.cdn.greenhouse.io",
			"fonts.gstatic.com",
			"www.gstatic.com",
		],
		formHosts: [
			// Hands out the upload's presigned fields (an xhr GET before each file).
			"boards.greenhouse.io",
			// Checks the typed email: it gets the address in its URL.
			"email-address-validator.us.greenhouse.io",
			// Greenhouse's upload bucket (a POST of each chosen file); this bucket only.
			"grnhse-prod-jben-us-east-1.s3.amazonaws.com",
		],
	},
	lever: {
		board: "lever",
		root: "form#application-form",
		container: "li.application-question",
		label: ".application-label",
		submit: "#btn-submit",
		success: {
			path: (formPath) => formPath.replace(/\/apply\/?$/, "/thanks"),
			text: "application submitted|thank you for applying|thanks for applying",
		},
		errors:
			".error-message:not(:empty), .application-error:not(:empty), [role=alert]:not(:empty)",
		hosts: [
			"cdn.lever.co",
			"lever-client-logos.s3.us-west-2.amazonaws.com",
			// hCaptcha's per-session hosts (a random label each time); hCaptcha owns the name.
			"*.w.hcaptcha.com",
		],
	},
	workable: {
		board: "workable",
		root: "form[data-ui=application-form]",
		// Text fields sit in the label that wraps them, choices in a fieldset, consent in its own label.
		container:
			"fieldset, label:not([data-ui=option] *):not([data-ui=option] > label)",
		label: "[id$=_label]",
		submit: "form[data-ui=application-form] button[data-ui=apply-button]",
		success: {
			// The success component in Workable's careers bundle (2026-11-09):
			// `data-ui="successful-submit"`, "Your application has been submitted successfully."
			text: "thank you for applying|application has been submitted successfully",
			selector: "[data-ui=successful-submit]",
		},
		errors: "[role=alert]:not(:empty), [data-ui$=-error]:not(:empty)",
		hosts: [
			"challenges.cloudflare.com",
			"dcvxs6ggqztsa.cloudfront.net",
			"d2y4rc9q318ytb.cloudfront.net",
			"workablehr.s3.amazonaws.com",
		],
		scan: {
			nameAttr: "data-ui",
			hiddenChoices: true,
			labelNoise: LABEL_NOISE,
			requiredText: "^\\s*\\*",
			// The privacy consent's asterisk is drawn in CSS (inspection, 2026-11-09).
			requiredNames: ["gdpr"],
		},
		declineCookies: "button[data-ui=cookie-consent-decline]",
	},
	recruitee: {
		board: "recruitee",
		root: "form#offer-application-form",
		container:
			"fieldset, div:has(> label):not(:has(> input[type=radio], > input[type=checkbox]))",
		label: "legend, label",
		submit: "form#offer-application-form button[type=submit]",
		success: {
			// Recruitee's tab panels, in the page before submit: the success one and the
			// "already applied" one (`…-content-offer-application-rate-limited`).
			text: "all done|thank you for (?:applying|your application)|application (?:has been |was )?(?:submitted|received|sent)",
			selector: "[id$=-content-offer-application-success]",
			refused: "[id$=-content-offer-application-rate-limited]",
		},
		errors: "[role=alert]:not(:empty)",
		hosts: [
			"careers.recruiteecdn.com",
			"captcha-base.recruiteecdn.com",
			"captcha-assets.recruiteecdn.com",
		],
		scan: { labelNoise: LABEL_NOISE },
		// "Accept only the necessary": nothing optional is ticked in its dialog.
		declineCookies: "button[data-testid=agree-to-selected-cookies]",
	},
	teamtailor: {
		board: "teamtailor",
		root: "form#job-application-form",
		container: "fieldset, div[id^=id_]",
		label: "legend, label",
		submit:
			"form#job-application-form input[type=submit], form#job-application-form button[type=submit]",
		success: {
			text: "thank you for (?:applying|your application)|application (?:has been |was )?(?:submitted|received|sent)",
		},
		errors: "[role=alert]:not(:empty), .error-message:not(:empty)",
		hosts: [
			"assets-aws.teamtailor-cdn.com",
			"images.teamtailor-cdn.com",
			"fonts.googleapis.com",
			"fonts.gstatic.com",
		],
		scan: { labelNoise: LABEL_NOISE, requiredText: "\\brequired\\b" },
		declineCookies: 'button[data-action*="common--cookies--alert#disableAll"]',
	},
	personio: {
		board: "personio",
		root: "form[class*=DynamicForm_formContainer]",
		container: "div:has(> label), [role=group]",
		label: "label, [id$=-label], [id^=doc-label]",
		submit: "form[class*=DynamicForm_formContainer] button[type=submit]",
		success: {
			text: "thank you for (?:applying|your application)|application (?:has been |was )?(?:submitted|received|sent)|vielen dank für (?:deine|ihre) bewerbung",
		},
		errors: "[role=alert]:not(:empty), [class*=errorMessage]:not(:empty)",
		hosts: ["assets.cdn.personio.de", "challenges.cloudflare.com"],
		scan: {
			labelNoise: LABEL_NOISE,
			requiredText: "\\(required\\)",
			attachedFiles: "[role=listitem] > span",
		},
		plainLocation: true,
	},
};

/**
 * What a real submission's session may reach: the allowed form hosts plus the board's own data
 * hosts (`formHosts`, any method), and its asset and scoring hosts (`hosts`, read-only) as rules.
 * Every other host is refused (quietly unless the request could carry the application). The form URL itself is still checked against the allowed
 * hosts only, so with none allowed nothing opens.
 */
export function sessionHosts(
	board: Board,
	allowed: string[],
): { form: string[]; rules: HostRules } {
	const config = BOARD_CONFIGS[board];
	return {
		form: [...new Set([...allowed, ...(config.formHosts ?? [])])],
		rules: joinRules({ assets: config.hosts ?? [] }, BOARD_HOST_RULES[board]),
	};
}

/** A board that keys the company in the subdomain: its origin, or the fixture base plus the company. */
function companyBase(
	base: string | undefined,
	company: string,
	domain: string,
): string {
	return base
		? `${base.replace(/\/+$/, "")}/${company}`
		: `https://${company.toLowerCase()}.${domain}`;
}

/** A board's hosted form URL for a job, or null when the job's URL is not on that board. */
export function applyUrl(
	board: Board,
	job: { url: string; externalId: string; companyKey: string },
	bases: Partial<Record<Board, string>> = {},
): string {
	const trim = (u: string) => u.replace(/\/+$/, "");
	switch (board) {
		case "ashby": {
			const base = bases.ashby ?? "https://jobs.ashbyhq.com";
			return `${trim(base)}/${job.companyKey}/${job.externalId}/application`;
		}
		case "greenhouse": {
			const base = bases.greenhouse ?? "https://job-boards.greenhouse.io";
			return `${trim(base)}/${job.companyKey}/jobs/${job.externalId}`;
		}
		case "lever": {
			const base = bases.lever ?? "https://jobs.lever.co";
			return `${trim(base)}/${job.companyKey}/${job.externalId}/apply`;
		}
		case "workable": {
			const base = bases.workable ?? "https://apply.workable.com";
			return `${trim(base)}/${job.companyKey}/j/${job.externalId}/apply/`;
		}
		case "recruitee": {
			// The stored id is `{company}:{slug}`; the form is the offer's /c/new page.
			const slug = job.externalId.slice(job.externalId.lastIndexOf(":") + 1);
			return `${companyBase(bases.recruitee, job.companyKey, "recruitee.com")}/o/${slug}/c/new`;
		}
		case "teamtailor": {
			// The job's path is `{id}-{slug}`; the feed's link has it, the id alone is the fallback.
			const tail = job.url.match(/\/jobs\/(\d+[^/?#]*)/)?.[1] ?? job.externalId;
			return `${companyBase(bases.teamtailor, job.companyKey, "teamtailor.com")}/jobs/${tail}/applications/new`;
		}
		case "personio":
			return `${companyBase(bases.personio, job.companyKey, "jobs.personio.de")}/job/${job.externalId}/apply`;
	}
}

export type FieldKind =
	| "text"
	| "textarea"
	| "select"
	| "combobox"
	| "radio"
	| "checkbox"
	| "yesno"
	| "file";

/** One question on the form, as scanned. `ref` addresses its control(s) via `[data-jp="ref"]`. */
export interface FormField {
	ref: string;
	kind: FieldKind;
	label: string;
	required: boolean;
	/** `name` or `id` of the control. */
	name: string;
	/** Choices for select, radio, checkbox and yes/no fields (comboboxes: read when opened). */
	options: string[];
	/** Hidden controls (e.g. Ashby's file inputs) are still fields; display decides nothing. */
	visible: boolean;
	/**
	 * What the control holds right now: the text, the chosen option(s), the pressed button, the
	 * attached file names. Empty when nothing is chosen (an option with an empty value counts as
	 * nothing). Older scans may lack it.
	 */
	current?: string[];
	/** A select that has an option with an empty value, so it can be left unanswered. */
	emptyOption?: boolean;
	/** The heading the field sits under inside the form ("Voluntary self-identification"); empty when none. */
	section?: string;
}

/**
 * Page script: finds every control in the form, stamps `data-jp` on it and returns one field per
 * question. Radios and checkboxes sharing a name are one field. Built as a string so bundler
 * helpers never end up inside the page.
 */
export function scanScript(config: BoardConfig): string {
	return `(() => {
	const cfg = ${JSON.stringify({ root: config.root, container: config.container, label: config.label, ...config.scan })};
	// Some boards split the form (Ashby renders its EEO survey in a second container).
	const roots = [...document.querySelectorAll(cfg.root)].filter((r, i, all) => !all.some((o, j) => j !== i && o.contains(r)));
	if (roots.length === 0) return null;
	const root = { querySelectorAll: (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]) };
	const noise = cfg.labelNoise ? new RegExp(cfg.labelNoise, "gi") : null;
	const clean = (t) => { const c = (t || "").replace(/[*✱]/g, " ").replace(/\\s+/g, " ").trim(); return noise ? c.replace(noise, " ").replace(/\\s+/g, " ").trim() : c; };
	const textOf = (el) => clean(el ? el.textContent : "");
	// The nearest container that has a question label, else the nearest one.
	const boxOf = (el) => {
		const first = el.closest(cfg.container);
		for (let box = first; box; box = box.parentElement && box.parentElement.closest(cfg.container))
			if (box.querySelector(cfg.label)) return box;
		return first;
	};
	const labelFor = (el) => {
		if (el.id) {
			const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
			if (l && textOf(l) && !/^(attach|enter manually)$/i.test(textOf(l))) return textOf(l);
		}
		const box = boxOf(el);
		const own = box && box.querySelector(cfg.label);
		if (own && textOf(own)) return textOf(own);
		const by = el.getAttribute("aria-labelledby");
		if (by) {
			const t = by.split(/\\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim();
			if (t) return t;
		}
		return clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
	};
	const requiredMark = (box) => {
		if (!box) return false;
		const label = box.querySelector(cfg.label);
		return !!(label && (/[*✱]/.test(label.textContent || "") || /required/i.test(label.className || "") || label.querySelector(".required")))
			|| box.getAttribute("aria-required") === "true" || !!box.querySelector('[role=group][aria-required="true"]')
			|| (!!cfg.requiredText && new RegExp(cfg.requiredText, "i").test(box.textContent || ""));
	};
	const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
	const optionText = (input) => {
		const wrap = input.closest("label");
		if (wrap && textOf(wrap)) return textOf(wrap);
		if (input.id) { const l = document.querySelector('label[for="' + CSS.escape(input.id) + '"]'); if (l) return textOf(l); }
		const by = input.getAttribute("aria-labelledby");
		if (by) { const t = by.split(/\\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim(); if (t) return t; }
		return clean(input.value);
	};
	const comboValue = (el) => {
		const control = el.closest('[class*="control"]') || el.parentElement;
		const single = control && control.querySelector('[class*="single-value"], [class*="singleValue"]');
		if (single && textOf(single)) return [textOf(single)];
		const hidden = control && control.querySelector('input[type=hidden]');
		return hidden && hidden.value.trim() ? [clean(hidden.value)] : [];
	};
	const currentOf = (el, kind) => {
		if (kind === "file") {
			const own = [...(el.files || [])].map((f) => f.name);
			// Some boards move a chosen file into a list and empty the input (Personio).
			const box = cfg.attachedFiles && !own.length ? el.closest(cfg.container) : null;
			return box ? [...box.querySelectorAll(cfg.attachedFiles)].map(textOf).filter(Boolean) : own;
		}
		if (kind === "select") return [...el.selectedOptions].filter((o) => o.value !== "").map((o) => clean(o.textContent));
		if (kind === "combobox") return comboValue(el);
		if (!el.value || !el.value.trim()) return [];
		return [isPhone(el) && !el.value.trim().startsWith("+") ? pickerCode(el) + el.value : el.value];
	};
	const isPhone = (el) => el.type === "tel" || /phone/i.test(el.name || el.id || "");
	// A phone widget that moved the country code into its picker (Workable): the code it shows,
	// read from the picker beside the box, goes in front, so the whole number is compared.
	const pickerCode = (el) => {
		let p = el.parentElement;
		for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
			for (const c of p.querySelectorAll("button, select, [role=combobox]")) {
				if (c === el) continue;
				const shown = c.tagName === "SELECT" ? (c.selectedOptions[0] || {}).textContent : c.textContent + " " + (c.getAttribute("aria-label") || "");
				const m = (shown || "").match(/\\+(\\d{1,4})\\b/);
				if (m) return "+" + m[1] + " ";
			}
		}
		return "";
	};
	const headings = root.querySelectorAll("h2, h3, h4, [class*=section-header], [class*=section-title]");
	const sectionOf = (el) => {
		let found = "";
		for (const h of headings) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = textOf(h);
		return found;
	};
	const fields = [];
	const seen = new Set();
	let n = 0;
	const stamp = (el) => { const ref = String(++n); el.setAttribute("data-jp", ref); return ref; };
	for (const yesno of root.querySelectorAll(".ashby-application-form-input-yesno")) {
		const box = boxOf(yesno);
		const hidden = yesno.querySelector("input");
		if (hidden) seen.add(hidden);
		const buttons = [...yesno.querySelectorAll("button")];
		fields.push({ ref: stamp(yesno), kind: "yesno", label: textOf(box && box.querySelector(cfg.label)), required: requiredMark(box), name: hidden ? hidden.name : "", options: buttons.map(textOf), visible: true, current: buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map(textOf), section: sectionOf(yesno) });
	}
	for (const el of root.querySelectorAll("input, textarea, select")) {
		if (seen.has(el)) continue;
		const type = (el.getAttribute("type") || el.tagName).toLowerCase();
		if (["hidden", "submit", "button", "search"].includes(type)) continue;
		if (el.name === "g-recaptcha-response" || el.name === "h-captcha-response") continue;
		// Helper inputs a widget hides from people (react-select's requiredInput) are not questions.
		if (type !== "file" && el.getAttribute("aria-hidden") === "true" && !(cfg.hiddenChoices && (type === "radio" || type === "checkbox"))) continue;
		const box = el.closest(cfg.container);
		if (type === "radio" || type === "checkbox") {
			// Same name and type only: a hidden twin of that name (Rails sends "0" for an unticked box,
			// Lever pairs its consent box with one) is not an option.
			const group = el.name ? [...root.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')].filter((g) => (g.getAttribute("type") || "").toLowerCase() === type) : [el];
			group.forEach((g) => seen.add(g));
			const ref = String(++n);
			group.forEach((g) => g.setAttribute("data-jp", ref));
			const fieldset = el.closest("fieldset");
			const legend = fieldset && fieldset.querySelector("legend");
			const named = fieldset && fieldset.getAttribute("aria-labelledby");
			const label = textOf(box && box.querySelector(cfg.label)) || textOf(legend) || (named ? named.split(/\\s+/).map((id) => textOf(document.getElementById(id))).join(" ").trim() : "") || (group.length === 1 ? optionText(el) : "");
			fields.push({ ref, kind: type, label, required: group.some((g) => g.required || g.getAttribute("aria-required") === "true") || requiredMark(box) || (cfg.requiredNames || []).includes(el.name), name: el.name || el.id, options: group.map(optionText), visible: group.some(visible), current: group.filter((g) => g.checked).map(optionText), section: sectionOf(el) });
			continue;
		}
		seen.add(el);
		const kind = type === "file" ? "file" : el.tagName === "SELECT" ? "select" : el.getAttribute("role") === "combobox" ? "combobox" : el.tagName === "TEXTAREA" ? "textarea" : "text";
		fields.push({
			ref: stamp(el),
			kind,
			label: labelFor(el),
			required: el.required || el.getAttribute("aria-required") === "true" || requiredMark(box),
			name: el.name || (cfg.nameAttr && el.getAttribute(cfg.nameAttr)) || el.id || "",
			options: el.tagName === "SELECT" ? [...el.options].filter((o) => o.value !== "").map((o) => clean(o.textContent)) : [],
			visible: kind === "file" ? true : visible(el),
			current: currentOf(el, kind),
			emptyOption: el.tagName === "SELECT" ? [...el.options].some((o) => o.value === "") : undefined,
			section: sectionOf(el),
		});
	}
	return fields;
})()`;
}

/**
 * Page script: the options the combobox `ref` shows once opened, from its own listbox (react-select
 * names its options after the input id; otherwise `aria-controls`), stamped for clicking.
 */
export function optionsScript(ref: string): string {
	return `(() => {
	const input = document.querySelector('[data-jp="${ref}"]');
	if (!input) return [];
	const visible = (o) => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
	let options = input.id ? [...document.querySelectorAll('[id^="react-select-' + CSS.escape(input.id) + '-option"]')] : [];
	const controls = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
	if (options.length === 0 && controls && document.getElementById(controls)) options = [...document.getElementById(controls).querySelectorAll("[role=option]")];
	if (options.length === 0) {
		const box = input.closest(".field-wrapper, li, .select, [class*=field]") || input.parentElement;
		options = [...(box ? box.querySelectorAll("[role=option]") : [])];
	}
	// Lever's location suggestions: plain divs, picked on mousedown.
	if (options.length === 0) {
		const box = input.closest("li, .application-field") || input.parentElement;
		options = [...(box ? box.querySelectorAll(".dropdown-results .dropdown-location") : [])];
	}
	for (const o of document.querySelectorAll("[data-jp-option]")) o.removeAttribute("data-jp-option");
	return options.filter(visible).map((o, i) => { o.setAttribute("data-jp-option", String(i)); return (o.textContent || "").replace(/\\s+/g, " ").trim(); });
})()`;
}

/**
 * Page script: a challenge that needs a person, visible now. Invisible widgets (reCAPTCHA
 * `size=invisible`, hCaptcha's hidden enclave frames, the Cloudflare bot script) are not one.
 */
export const VISIBLE_CHALLENGE_SCRIPT = `(() => {
	const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 60 && r.height > 60 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1; };
	for (const f of document.querySelectorAll("iframe")) {
		const src = f.src || "";
		if (!shown(f)) continue;
		if (/recaptcha\\/.*\\/bframe/.test(src)) return "reCAPTCHA challenge";
		if (/recaptcha\\/.*\\/anchor/.test(src) && !/size=invisible/.test(src)) return "reCAPTCHA checkbox";
		if (/hcaptcha/.test(src) && /frame=(challenge|checkbox)/.test(src)) return "hCaptcha challenge";
		if (/challenges\\.cloudflare\\.com/.test(src)) return "Cloudflare Turnstile";
		if (/captcha-delivery\\.com|arkoselabs|funcaptcha/.test(src)) return "CAPTCHA";
	}
	for (const el of document.querySelectorAll(".cf-turnstile, #challenge-form, #challenge-stage, [data-captcha-challenge]")) if (shown(el)) return "challenge";
	// Turnstile draws its frame in a shadow root: the box around its response field is what shows.
	for (const t of document.querySelectorAll('[name="cf-turnstile-response"]')) { const box = t.parentElement; const r = box ? box.getBoundingClientRect() : null; if (r && r.width > 100 && r.height > 30 && getComputedStyle(box).visibility !== "hidden") return "Cloudflare Turnstile"; }
	if (/^\\s*just a moment/i.test(document.title)) return "Cloudflare interstitial";
	return null;
})()`;

/** Page script: visible validation messages. */
export function errorsScript(config: BoardConfig): string {
	return `[...document.querySelectorAll(${JSON.stringify(config.errors)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 10)`;
}

/** Words that make a would-be confirmation a refusal. */
const REFUSAL =
	"\\b(?:rejected|declined|not (?:been )?(?:submitted|received|accepted)|unsuccessful|could ?n[o']t|failed|error|try again|already (?:applied|submitted|received|sent)|duplicate)\\b";

/** A page that says the candidate applied before: never a confirmation of this submission. */
const DUPLICATE =
	"\\balready (?:applied|submitted|received|sent)\\b|\\bduplicate application\\b";

/**
 * Page script: the confirmation text when the board shows its confirmation, else null. All of
 * these must hold: same host as the form, no visible error or challenge, the form and its submit
 * button gone, the board's exact confirmation path (Greenhouse, Lever) or its confirmation
 * element (Ashby), the confirmation text there, and no refusal wording.
 */
export function successScript(config: BoardConfig, formUrl: string): string {
	const { text, selector, path, refused } = config.success;
	// Text alone is no evidence: without the board's path or element nothing is confirmed.
	if (!path && !selector) return "null";
	const form = new URL(formUrl);
	const expected = {
		host: form.host,
		path: path ? path(form.pathname).replace(/\/+$/, "") : null,
	};
	return `(() => {
	const expected = ${JSON.stringify(expected)};
	const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
	if (location.host !== expected.host) return null;
	if ([...document.querySelectorAll(${JSON.stringify(config.errors)})].some(shown)) return null;
	if (${VISIBLE_CHALLENGE_SCRIPT}) return null;
	if ([...document.querySelectorAll(${JSON.stringify(`${config.root}, ${config.submit}`)})].some(shown)) return null;
	if (expected.path !== null && location.pathname.replace(/\\/+$/, "") !== expected.path) return null;
	const scope = ${JSON.stringify(selector ?? null)} ? document.querySelector(${JSON.stringify(selector ?? "")}) : document.body;
	// Hidden nodes count for nothing: some boards ship their confirmation in the page before submit.
	if (!scope || !shown(scope)) return null;
	// The board's own "already applied" state, or a duplicate anywhere on the page, is a refusal.
	if (${JSON.stringify(refused ?? null)} && [...document.querySelectorAll(${JSON.stringify(refused ?? "")})].some(shown)) return null;
	if (new RegExp(${JSON.stringify(DUPLICATE)}, "i").test((document.body.innerText || "").slice(0, 20000))) return null;
	const body = (scope.innerText || "").slice(0, 5000);
	if (new RegExp(${JSON.stringify(REFUSAL)}, "i").test(body)) return null;
	const m = body.match(new RegExp(${JSON.stringify(text)}, "i"));
	return m ? m[0] : null;
})()`;
}

/* --------------------------------------------------------------- matching */

/** Fields filled from the contact details and approved documents, by label or control name. */
export type SystemRole =
	| "full_name"
	| "first_name"
	| "last_name"
	| "email"
	| "phone"
	/** Greenhouse's country picker beside the phone number, set by the page from the number. */
	| "phone_country"
	| "location"
	| "linkedin"
	| "github"
	| "website"
	| "resume"
	| "cover_letter"
	| "cover_letter_text"
	| "voluntary"
	| "ignore";

const ROLE_BY_NAME: [RegExp, SystemRole][] = [
	// Control names hold in every language the form is shown in (Recruitee and Personio follow
	// the employer's locale).
	[/^(_systemfield_name|name|candidate\.name)$/, "full_name"],
	[/^(first_name|firstname|candidate\[first_name\])$/, "first_name"],
	[/^(last_name|lastname|candidate\[last_name\])$/, "last_name"],
	[/^(_systemfield_email|email|candidate\.email|candidate\[email\])$/, "email"],
	[/^(phone|candidate\.phone|candidate\[phone\])$/, "phone"],
	[/^location$/, "location"],
	[/^urls\[linkedin\]$/i, "linkedin"],
	[/^urls\[github\]$/i, "github"],
	[/^urls\[portfolio\]$/i, "website"],
	[
		/^(_systemfield_resume|resume|candidate\.cv|documents\.cv|candidate_resume_remote_url)$/,
		"resume",
	],
	[/^candidate\.coverLetterFile$/, "cover_letter"],
	[/^cover_letter$/, "cover_letter"],
	[/^comments$/, "cover_letter_text"],
	[/^(resume_text|cover_letter_text)$/, "ignore"],
	[
		/_systemfield_eeoc|^(gender|race|hispanic_ethnicity|veteran_status|disability_status)$/,
		"voluntary",
	],
];

const ROLE_BY_LABEL: [RegExp, SystemRole][] = [
	[/^(full )?name$/, "full_name"],
	[/^first name$/, "first_name"],
	[/^(last name|surname|family name)$/, "last_name"],
	[/^e ?mail( address)?$/, "email"],
	[/^(phone|phone number|mobile)$/, "phone"],
	[
		/^(current )?location$|^where are you (currently )?(based|located)$/,
		"location",
	],
	[/^linkedin( profile| url)?$/, "linkedin"],
	[/^github( profile| url)?$/, "github"],
	[
		/^(website|portfolio|personal website|portfolio url|website url)$/,
		"website",
	],
	[/^(?:upload )?(resume|cv|resume ?\/ ?cv|cv or resume)$/, "resume"],
	[/^cover letter$/, "cover_letter"],
	[/^additional information$/, "cover_letter_text"],
	[
		/\b(gender|race|ethnicity|hispanic|latino|veteran|disability|pronouns|sexual orientation)\b/,
		"voluntary",
	],
];

export function systemRole(field: FormField): SystemRole | null {
	if (field.kind === "combobox" && field.name === "country")
		return "phone_country";
	const role = roleOf(field);
	// A cover letter box that takes text (Workable, Teamtailor) gets the approved letter's text.
	if (
		role === "cover_letter" &&
		(field.kind === "text" || field.kind === "textarea")
	)
		return "cover_letter_text";
	return role;
}

function roleOf(field: FormField): SystemRole | null {
	for (const [pattern, role] of ROLE_BY_NAME)
		if (pattern.test(field.name)) return role;
	const label = normalizeForMatch(field.label)
		.replace(/[^\p{L}\d/ ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (field.kind === "file") {
		for (const [pattern, role] of ROLE_BY_LABEL)
			if (pattern.test(label) && (role === "resume" || role === "cover_letter"))
				return role;
		return "ignore";
	}
	for (const [pattern, role] of ROLE_BY_LABEL)
		if (pattern.test(label)) return role;
	return null;
}

function words(text: string): string[] {
	return normalizeForMatch(text)
		.replace(/[^\p{L}\d]+/gu, " ")
		.split(" ")
		.filter((w) => w.length > 2);
}

/** The question text as a key: case, punctuation and markers removed. */
export function questionKeyOf(text: string): string {
	return normalizeForMatch(text)
		.replace(/[^\p{L}\d]+/gu, " ")
		.trim();
}

/** Same question when the keys are equal, or each shares at least 85% of its words with the other. */
export function sameQuestion(a: string, b: string): boolean {
	if (questionKeyOf(a) === questionKeyOf(b)) return true;
	const wa = new Set(words(a));
	const wb = new Set(words(b));
	if (wa.size === 0 || wb.size === 0) return false;
	let shared = 0;
	for (const w of wa) if (wb.has(w)) shared++;
	return shared / wa.size >= 0.85 && shared / wb.size >= 0.85;
}

/** The option an answer names exactly (after normalizing case and punctuation), or null. */
export function exactOption(answer: string, options: string[]): string | null {
	const key = questionKeyOf(answer);
	return options.find((o) => questionKeyOf(o) === key) ?? null;
}

export function findAnswer(
	label: string,
	answers: FormAnswer[],
): FormAnswer | null {
	return answers.find((a) => sameQuestion(a.question, label)) ?? null;
}

/* ------------------------------------------------------------------- plan */

export interface ApplicantData {
	contact: Contact;
	/** The approved form answers. */
	answers: FormAnswer[];
	/** Plain text of the approved letter, for boards with a text box and no upload. */
	coverLetterText: string | null;
	hasCoverLetterFile: boolean;
}

export type FillAction =
	| { ref: string; label: string; kind: "fill"; value: string }
	| { ref: string; label: string; kind: "select"; value: string }
	| { ref: string; label: string; kind: "combobox"; value: string }
	| { ref: string; label: string; kind: "choose"; values: string[] }
	| { ref: string; label: string; kind: "yesno"; value: string }
	| { ref: string; label: string; kind: "location"; value: string }
	| { ref: string; label: string; kind: "file"; file: "cv" | "cover_letter" }
	/**
	 * Nothing to do: the page sets this control itself from another approved value (Greenhouse's
	 * phone country from the number). Listed in review and checked after filling.
	 */
	| { ref: string; label: string; kind: "expect"; value: string }
	/** Empties a control that arrived answered: text, a select's empty option, ticked boxes. */
	| {
			ref: string;
			label: string;
			kind: "clear";
			control: "text" | "select" | "checkbox";
	  };

export interface UnknownQuestion {
	label: string;
	required: boolean;
	kind: FieldKind;
	options: string[];
	/** Set when an approved answer exists but is not one of the options. */
	answered?: string;
	/** What the form had already chosen when the field cannot be emptied (a radio, a select with no empty option). */
	preset?: string[];
}

export interface FillPlan {
	actions: FillAction[];
	/** Required questions with no approved answer: the application stops before anything is sent. */
	unknown: UnknownQuestion[];
	/** Optional questions left empty. */
	blank: string[];
}

function splitName(name: string): { first: string; last: string } {
	const parts = name.trim().split(/\s+/);
	return {
		first: parts.slice(0, -1).join(" ") || parts[0] || "",
		last: parts.length > 1 ? (parts.at(-1) ?? "") : "",
	};
}

/**
 * The country calling code a phone number starts with ("+1 555 …" gives "+1"), when it is set
 * apart by a space, dash, dot or bracket; null otherwise.
 */
export function dialCode(phone: string): string | null {
	const match = phone.trim().match(/^\+(\d{1,4})[\s\-.(]/);
	return match ? `+${match[1]}` : null;
}

function contactValue(role: SystemRole, data: ApplicantData): string {
	const c = data.contact;
	const { first, last } = splitName(c.name);
	const url = (u: string) =>
		u && !/^https?:\/\//i.test(u) ? `https://${u}` : u;
	switch (role) {
		case "full_name":
			return c.name;
		case "first_name":
			return first;
		case "last_name":
			return last;
		case "email":
			return c.email;
		case "phone":
			return c.phone;
		case "location":
			return c.location;
		case "linkedin":
			return url(c.linkedin);
		case "github":
			return url(c.github);
		case "website":
			return url(c.website);
		case "cover_letter_text":
			return data.coverLetterText ?? "";
		default:
			return "";
	}
}

/** An option that declines to self-identify ("Decline to self-identify", "I prefer not to say"). */
const DECLINE =
	/\b(?:decline|declined|prefer not|rather not|do not wish|don ?t wish|not wish to|choose not to|not to (?:say|disclose|answer|identify|self identify))\b/;

/** The option of a self-identification question that declines to answer, or null. */
export function declineOption(field: FormField): string | null {
	return field.options.find((o) => DECLINE.test(questionKeyOf(o))) ?? null;
}

/**
 * A contact field's action, or null when the contact details do not answer it. Greenhouse's
 * phone country is set by the page from the number: it is expected, not filled. A location
 * suggestion the user picked in Questions (an approved answer) wins over the profile's text.
 */
function contactAction(
	field: FormField,
	role: SystemRole,
	data: ApplicantData,
	plainLocation: boolean,
): FillAction | null {
	const base = { ref: field.ref, label: field.label };
	if (role === "phone_country") {
		const code = dialCode(data.contact.phone);
		return code ? { ...base, kind: "expect", value: code } : null;
	}
	const value =
		(role === "location"
			? findAnswer(field.label, data.answers)?.answer
			: "") || contactValue(role, data);
	if (!value || (field.kind !== "text" && field.kind !== "textarea"))
		return null;
	return {
		...base,
		kind:
			role === "location" && field.name === "location" && !plainLocation
				? "location"
				: "fill",
		value,
	};
}

export interface PlanOptions {
	/**
	 * Self-identification questions without an approved answer take their "decline to answer"
	 * option when they offer one. Only for a form read before review, whose values the user
	 * approved in the "What will be sent" list (docs/auto-apply-plan.md, step 3).
	 */
	declineVoluntary?: boolean;
	/** The location box is plain text (Personio), not Lever's lookup. */
	plainLocation?: boolean;
}

/**
 * Decides every field's value from approved data only. File fields come last so nothing is
 * uploaded (some boards upload on selection) before the rest of the form is known to be fillable.
 */
export function planFill(
	fields: FormField[],
	data: ApplicantData,
	options: PlanOptions = {},
): FillPlan {
	const plan: FillPlan = { actions: [], unknown: [], blank: [] };
	const files: FillAction[] = [];
	const ask = (field: FormField, extra: Partial<UnknownQuestion> = {}) =>
		plan.unknown.push({
			label: field.label || field.name,
			required: true,
			kind: field.kind,
			options: field.options,
			...extra,
		});
	const unknown = (field: FormField, answered?: string) => {
		if (field.required) {
			ask(field, answered ? { answered } : {});
			return;
		}
		// Left blank only if it really is blank: whatever the form preselected is not an answer
		// the user approved, so it is cleared, or the question is asked when it cannot be.
		const current = field.current ?? [];
		if (current.length === 0 || field.kind === "file") {
			plan.blank.push(field.label || field.name);
			return;
		}
		const control =
			field.kind === "text" || field.kind === "textarea"
				? "text"
				: field.kind === "checkbox"
					? "checkbox"
					: field.kind === "select" && field.emptyOption
						? "select"
						: null;
		if (!control || !field.visible) {
			ask(field, { preset: current, ...(answered ? { answered } : {}) });
			return;
		}
		plan.actions.push({
			ref: field.ref,
			label: field.label,
			kind: "clear",
			control,
		});
		plan.blank.push(field.label || field.name);
	};
	for (const field of fields) {
		const role = systemRole(field);
		if (role === "ignore") continue;
		if (field.kind === "file") {
			if (role === "resume")
				files.push({
					ref: field.ref,
					label: field.label,
					kind: "file",
					file: "cv",
				});
			else if (role === "cover_letter" && data.hasCoverLetterFile)
				files.push({
					ref: field.ref,
					label: field.label,
					kind: "file",
					file: "cover_letter",
				});
			else unknown(field);
			continue;
		}
		if (role === "voluntary") {
			// Self-identification is the user's to give: an approved answer is used, or, on a form
			// read before review, the field's own "decline" option, shown in the approved list.
			const answer = findAnswer(field.label, data.answers);
			const decline = options.declineVoluntary ? declineOption(field) : null;
			if (!answer && decline) {
				plan.actions.push(declineAction(field, decline));
				continue;
			}
			if (!answer) {
				unknown(field);
				continue;
			}
		}
		if (role && role !== "voluntary") {
			const action = contactAction(
				field,
				role,
				data,
				options.plainLocation === true,
			);
			if (action) plan.actions.push(action);
			else unknown(field);
			continue;
		}
		const answer = findAnswer(field.label, data.answers);
		if (!answer) {
			unknown(field);
			continue;
		}
		switch (field.kind) {
			case "text":
			case "textarea":
				plan.actions.push({
					ref: field.ref,
					label: field.label,
					kind: "fill",
					value: answer.answer,
				});
				break;
			case "combobox":
				plan.actions.push({
					ref: field.ref,
					label: field.label,
					kind: "combobox",
					value: answer.answer,
				});
				break;
			case "select":
			case "yesno": {
				const option = exactOption(answer.answer, field.options);
				if (!option) unknown(field, answer.answer);
				else
					plan.actions.push({
						ref: field.ref,
						label: field.label,
						kind: field.kind === "select" ? "select" : "yesno",
						value: option,
					});
				break;
			}
			case "radio":
			case "checkbox": {
				const wanted =
					field.kind === "checkbox"
						? answer.answer
								.split(/\n|;/)
								.map((s) => s.trim())
								.filter(Boolean)
						: [answer.answer];
				const values = wanted.map((w) => exactOption(w, field.options));
				if (values.some((v) => v === null) || values.length === 0)
					unknown(field, answer.answer);
				else
					plan.actions.push({
						ref: field.ref,
						label: field.label,
						kind: "choose",
						values: values as string[],
					});
				break;
			}

			default:
				// File fields were handled before this switch.
				break;
		}
	}
	plan.actions.push(...files);
	return plan;
}

function declineAction(field: FormField, option: string): FillAction {
	const base = { ref: field.ref, label: field.label };
	switch (field.kind) {
		case "select":
			return { ...base, kind: "select", value: option };
		case "combobox":
			return { ...base, kind: "combobox", value: option };
		case "yesno":
			return { ...base, kind: "yesno", value: option };
		default:
			return { ...base, kind: "choose", values: [option] };
	}
}

/**
 * The same phone number, on a phone field only: every digit equal, country code included. A
 * widget that moves the code into its picker is read with the picker's code in front (scanScript).
 */
function samePhone(field: FormField, held: string, approved: string): boolean {
	if (systemRole(field) !== "phone") return false;
	if (!/^\+?[\d\s().-]+$/.test(approved)) return false;
	return held.replace(/\D/g, "") === approved.replace(/\D/g, "");
}

const fieldKey = (f: FormField) => `${f.kind}|${f.name}|${f.label}`;
/** An option chosen from the page's own list: its text may differ in case and punctuation. */
const same = (a: string, b: string) => questionKeyOf(a) === questionKeyOf(b);

/** Only what never changes meaning: outer and repeated whitespace, and Unicode composition. */
const tidy = (text: string) =>
	text.normalize("NFC").replace(/\s+/g, " ").trim();

const EMAIL = /^([^\s@]+)@([^\s@]+)$/;
const LINK = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#\s]+\.[^/?#\s]+)([/?#].*)?$/i;

/**
 * True when a typed value holds exactly the approved text. Every character counts ("+" and "-"
 * in an email, "/" and "-" in a link), except the case of an email's domain and of a link's
 * scheme and host, which never change where it leads.
 */
function sameText(held: string, approved: string): boolean {
	const a = tidy(held);
	const b = tidy(approved);
	if (a === b) return true;
	const mailA = a.match(EMAIL);
	const mailB = b.match(EMAIL);
	if (mailA && mailB)
		return (
			mailA[1] === mailB[1] &&
			(mailA[2] ?? "").toLowerCase() === (mailB[2] ?? "").toLowerCase()
		);
	const linkA = a.match(LINK);
	const linkB = b.match(LINK);
	if (linkA && linkB)
		return (
			(linkA[1] ?? "").toLowerCase() === (linkB[1] ?? "").toLowerCase() &&
			(linkA[2] ?? "").toLowerCase() === (linkB[2] ?? "").toLowerCase() &&
			(linkA[3] ?? "") === (linkB[3] ?? "")
		);
	return false;
}

/** Why a control's value is not the planned one, or null when it is. */
function mismatch(
	field: FormField,
	action: FillAction,
	label: string,
	current: string[],
): string | null {
	const holds = current.length ? `"${current.join("; ")}"` : "nothing";
	const one = current.length === 1 ? (current[0] ?? "") : null;
	switch (action.kind) {
		case "fill": {
			const ok =
				one !== null &&
				(sameText(one, action.value) || samePhone(field, one, action.value));
			return ok ? null : `"${label}" holds ${holds}, not the approved value.`;
		}
		case "select":
		case "yesno":
			return one !== null && same(one, action.value)
				? null
				: `"${label}" holds ${holds}, not "${action.value}".`;
		case "choose": {
			const want = action.values.map(questionKeyOf).sort().join("|");
			const have = current.map(questionKeyOf).sort().join("|");
			return want === have
				? null
				: `"${label}" holds ${holds}, not "${action.values.join("; ")}".`;
		}
		case "combobox":
		case "location":
			if (current.length === 0)
				return `"${label}" is empty after choosing "${action.value}".`;
			return same(current[0] ?? "", action.value)
				? null
				: `"${label}" holds ${holds}, not "${action.value}".`;
		case "expect":
			return one !== null &&
				(one === action.value || one.endsWith(` ${action.value}`))
				? null
				: `"${label}" holds ${holds}, not "${action.value}".`;
		case "file":
			return current.length === 0 ? `"${label}" has no file attached.` : null;
		case "clear":
			// Checked by the caller: nothing may be held.
			return null;
	}
}

/**
 * The last check before the claim: reads the form again and compares every control with the
 * plan. Each must hold exactly its approved value, or nothing (blank, cleared or not ours to
 * fill). A preselected answer that stuck, an extra ticked option, a changed value or a question
 * that appeared while filling is a problem; nothing is submitted then.
 */
export function verifyFilled(
	plan: FillPlan,
	planned: FormField[],
	now: FormField[],
): string[] {
	const byRef = new Map(planned.map((f) => [f.ref, f]));
	const expected = new Map<string, FillAction>();
	for (const action of plan.actions) {
		const field = byRef.get(action.ref);
		if (field) expected.set(fieldKey(field), action);
	}
	const known = new Set(planned.map(fieldKey));
	const problems: string[] = [];
	for (const field of now) {
		const label = field.label || field.name;
		const current = field.current ?? [];
		const action = expected.get(fieldKey(field));
		if (!known.has(fieldKey(field))) {
			if (field.required || current.length > 0)
				problems.push(
					`"${label}" appeared while filling and has no approved answer.`,
				);
			continue;
		}
		const holds = current.length ? `"${current.join("; ")}"` : "nothing";
		if (!action || action.kind === "clear") {
			if (field.kind !== "file" && current.length > 0)
				problems.push(`"${label}" holds ${holds}, which was not approved.`);
			continue;
		}
		const problem = mismatch(field, action, label, current);
		if (problem) problems.push(problem);
	}
	return problems;
}

/** The approved letter's Markdown as plain text for a text box. */
export function markdownToPlain(markdown: string): string {
	return markdown
		.replace(/\\$/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/(^|\s)\*(\S[^*]*)\*/g, "$1$2")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
