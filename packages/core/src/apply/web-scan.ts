import type { FormField } from "./forms";

/**
 * Page scripts for an employer's own application form (the "web" board, docs/auto-apply-plan.md
 * step 6). No board config: the form is found by its controls, each question's label is read
 * from the DOM and the accessibility attributes (`label[for]`, a wrapping label, `aria-labelledby`,
 * `aria-label`, a fieldset's legend, `placeholder`, `title`), and required markers from
 * `required`, `aria-required`, an asterisk or "(required)". Built as strings so bundler helpers
 * never end up inside the page. Controls are stamped `data-jp` (questions) and `data-jp-control`
 * (buttons), as the board scan does.
 */

/** A field of an employer's form, with what the scan saw around it. */
export interface WebField extends FormField {
	/** Text near the control when no label names it (for the model to label from), else empty. */
	hint: string;
	/** The control's `autocomplete` token, when it has one. */
	autocomplete: string;
	/** An input's `type` (`email`, `tel` …), else empty. */
	inputType: string;
	/** 1 for the step shown now; 2, 3 … for steps the form keeps hidden in the page. */
	step: number;
}

/** A button-like control of the form. */
export interface WebControl {
	ref: string;
	text: string;
	/** `submit` (a submit button that belongs to the form), `button`, `link` or `other`. */
	type: string;
}

export interface WebScan {
	/** The form sits in a frame of the page: that frame's URL. */
	frameUrl: string | null;
	/** The only form-like thing is a frame whose document is out of reach (another site). */
	frameHost: string | null;
	fields: WebField[];
	controls: WebControl[];
	/** A visible password box: the form wants an account. */
	password: boolean;
	/** A box for an email or SMS code. */
	code: string | null;
	/** Words saying the page wants a sign-in before applying, when there is no form. */
	signIn: string | null;
	errors: string[];
	/**
	 * Where the form says it sends, as absolute URLs: its `action` and the `formaction` of every
	 * button or input that belongs to it, shown or not.
	 */
	endpoints: string[];
	/**
	 * The form has a submit button of its own, shown or kept hidden in a later step (a `<button>`
	 * without another type or an `<input type=submit|image>` that belongs to it).
	 */
	canSubmit: boolean;
}

/** Visible error messages of a generic form. */
export const WEB_ERRORS =
	"[role=alert]:not(:empty), .error:not(:empty), .error-message:not(:empty), .invalid-feedback:not(:empty), .field-error:not(:empty), [id$=-error]:not(:empty)";

/** Page script: the form on this page, as a `WebScan`. */
export const WEB_SCAN_SCRIPT = String.raw`(() => {
	const clean = (t) => (t || "").replace(/[*✱]/g, " ").replace(/\((?:required|optional)\)/gi, " ").replace(/\s+/g, " ").trim();
	const textOf = (el) => clean(el ? el.textContent : "");
	const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
	const kindOf = (el) => {
		const type = (el.getAttribute("type") || "").toLowerCase();
		if (el.tagName === "SELECT") return "select";
		if (el.tagName === "TEXTAREA") return "textarea";
		if (el.getAttribute("role") === "combobox") return "combobox";
		if (type === "file" || type === "radio" || type === "checkbox") return type;
		return "text";
	};
	const fillable = (el) => {
		const type = (el.getAttribute("type") || "").toLowerCase();
		if (["hidden", "submit", "button", "reset", "image", "search", "password"].includes(type)) return false;
		if (/^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/.test(el.name || "")) return false;
		if (el.disabled) return false;
		return true;
	};
	const CONTROLS = "input, select, textarea, [role=combobox]:not(input)";
	for (const el of document.querySelectorAll("[data-jp], [data-jp-control], [data-jp-form]")) { el.removeAttribute("data-jp"); el.removeAttribute("data-jp-control"); el.removeAttribute("data-jp-form"); }
	const result = { frameUrl: null, frameHost: null, fields: [], controls: [], password: false, code: null, signIn: null, errors: [], endpoints: [], canSubmit: false };
	result.password = [...document.querySelectorAll("input[type=password]")].some(shown);
	// The form: the <form> with the most visible questions, else the page when it has some.
	const score = (root) => [...root.querySelectorAll(CONTROLS)].filter((el) => fillable(el) && (shown(el) || el.type === "file")).length;
	const forms = [...document.querySelectorAll("form")].map((f) => [f, score(f)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
	let root = forms.length && forms[0][1] >= 2 ? forms[0][0] : null;
	if (!root && score(document.body) >= 2) root = document.body;
	const bodyText = (document.body.innerText || "").slice(0, 8000);
	if (!root) {
		for (const f of document.querySelectorAll("iframe")) {
			const r = f.getBoundingClientRect();
			if (r.width < 200 || r.height < 150 || !f.src) continue;
			let reachable = false;
			try { reachable = !!(f.contentDocument && f.contentDocument.body); } catch {}
			if (reachable) { result.frameUrl = f.src; return result; }
			try { result.frameHost = new URL(f.src, location.href).host; } catch {}
			return result;
		}
		const m = bodyText.match(/(?:sign|log) ?in to (?:apply|continue)|create an account to (?:apply|continue)|you must (?:sign|log) ?in|login required|sign in with your account/i);
		result.signIn = m ? m[0] : null;
		return result;
	}
	root.setAttribute("data-jp-form", "1");
	if (root.tagName === "FORM" && root.getAttribute("action")) result.endpoints.push(root.action);
	const labelText = (id) => textOf(document.getElementById(id));
	const byIds = (ids) => (ids || "").split(/\s+/).filter(Boolean).map(labelText).join(" ").trim();
	const forLabel = (el) => { if (!el.id) return ""; const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return l ? textOf(l) : ""; };
	const ownLabel = (el) => {
		const wrap = el.closest("label");
		if (wrap) { const copy = wrap.cloneNode(true); for (const c of copy.querySelectorAll("input, select, textarea, option")) c.remove(); const t = textOf(copy); if (t) return t; }
		return "";
	};
	const nearby = (el) => {
		// The closest text before the control inside its own box: a heading or a span acting as label.
		let box = el.parentElement;
		for (let i = 0; i < 3 && box && box !== root; i++, box = box.parentElement) {
			const copy = box.cloneNode(true);
			for (const c of copy.querySelectorAll("input, select, textarea, option, button, script, style")) c.remove();
			const t = textOf(copy);
			if (t && t.length <= 120) return t;
			if (t) return t.slice(0, 120);
		}
		return "";
	};
	const labelOf = (el) => forLabel(el) || ownLabel(el) || byIds(el.getAttribute("aria-labelledby")) || clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "");
	const requiredOf = (el, label, box) => el.required || el.getAttribute("aria-required") === "true" || /[*✱]/.test(label) || /\(required\)|\brequired\b/i.test(label) || (!!box && box.getAttribute("aria-required") === "true");
	const rawLabel = (el) => { if (!el.id) return ""; const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return l ? l.textContent || "" : ""; };
	// An id a page generates per load (React's ":r1:", a UUID, a long hash) names nothing stable.
	const stableId = (v) => !!v && !/[:«»]|\d{5,}|[0-9a-f]{8,}|^[0-9a-f-]{16,}$/i.test(v.replace(/[^0-9a-z:«»-]/gi, ""));
	// A name is what the server receives, so it holds across loads unless it is a UUID or React's.
	const stableName = (v) => !!v && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^:r[0-9a-z]*:$|[«»]/i.test(v);
	// No name, no stable id and no label: the control's place among the unlabelled ones of its
	// kind (its key is then checked against the text beside it, web-form.ts).
	const counts = {};
	const position = (kind) => { counts[kind] = (counts[kind] || 0) + 1; return "#" + kind + "-" + counts[kind]; };
	// Steps the form keeps hidden in the page: each hidden box with questions is one, in order.
	const hiddenBox = (el) => { let found = null; for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (getComputedStyle(p).display === "none") found = p; return found; };
	const boxes = [];
	const stepOf = (el) => {
		if (shown(el)) return 1;
		const box = hiddenBox(el);
		// A file input is often hidden behind its own button: it belongs to the step it sits in.
		if (!box) return el.type === "file" ? 1 : 0;
		// A hidden box with one unlabelled control is a trap for bots (a honeypot), not a step.
		const labelled = [...box.querySelectorAll("label, legend")].some((l) => textOf(l));
		if (!labelled && box.querySelectorAll(CONTROLS).length < 2) return 0;
		let i = boxes.indexOf(box);
		if (i < 0) { boxes.push(box); i = boxes.length - 1; }
		return i + 2;
	};
	const headings = [...root.querySelectorAll("h2, h3, h4, legend")];
	const sectionOf = (el) => { let found = ""; for (const h of headings) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = textOf(h); return found; };
	const optionText = (input) => ownLabel(input) || forLabel(input) || byIds(input.getAttribute("aria-labelledby")) || clean(input.getAttribute("aria-label") || input.value);
	const seen = new Set();
	let n = 0;
	for (const el of root.querySelectorAll(CONTROLS)) {
		if (seen.has(el) || !fillable(el)) continue;
		const kind = kindOf(el);
		const step = stepOf(el);
		// A lone control hidden by its own style (a honeypot) is no question.
		if (step === 0) continue;
		if (kind === "radio" || kind === "checkbox") {
			const group = el.name ? [...root.querySelectorAll('input[name="' + CSS.escape(el.name) + '"]')].filter((g) => (g.getAttribute("type") || "").toLowerCase() === kind) : [el];
			group.forEach((g) => seen.add(g));
			const ref = String(++n);
			group.forEach((g) => g.setAttribute("data-jp", ref));
			const fieldset = el.closest("fieldset, [role=group], [role=radiogroup]");
			const legend = fieldset && fieldset.querySelector("legend");
			const label = textOf(legend) || (fieldset ? byIds(fieldset.getAttribute("aria-labelledby")) || clean(fieldset.getAttribute("aria-label") || "") : "") || (group.length === 1 ? optionText(el) : "");
			const raw = (legend && legend.textContent) || label;
			result.fields.push({ ref, kind, label, required: group.some((g) => g.required || g.getAttribute("aria-required") === "true") || requiredOf(el, raw, fieldset), name: (stableName(el.name) && el.name) || (label ? "" : position(kind)), options: group.map(optionText), visible: group.some(shown), current: group.filter((g) => g.checked).map(optionText), section: sectionOf(el), hint: label ? "" : nearby(fieldset || el), autocomplete: "", inputType: kind, step });
			continue;
		}
		seen.add(el);
		const ref = String(++n);
		el.setAttribute("data-jp", ref);
		const label = labelOf(el);
		const raw = rawLabel(el) || (el.closest("label") ? el.closest("label").textContent || "" : "") || label;
		const current = kind === "file" ? [...(el.files || [])].map((f) => f.name) : kind === "select" ? [...el.selectedOptions].filter((o) => o.value !== "").map((o) => clean(o.textContent)) : kind === "combobox" ? [] : el.value && el.value.trim() ? [el.value] : [];
		result.fields.push({
			ref, kind, label,
			required: requiredOf(el, raw, el.closest("[aria-required]")),
			name: (stableName(el.name) && el.name) || (stableId(el.id) && el.id) || (label ? "" : position(kind)),
			options: el.tagName === "SELECT" ? [...el.options].filter((o) => o.value !== "").map((o) => clean(o.textContent)) : [],
			visible: kind === "file" ? true : shown(el),
			current,
			emptyOption: el.tagName === "SELECT" ? [...el.options].some((o) => o.value === "") : undefined,
			section: sectionOf(el),
			hint: label ? "" : nearby(el),
			autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
			inputType: (el.getAttribute("type") || "").toLowerCase(),
			step,
		});
	}
	const codeBox = result.fields.find((f) => f.visible && (f.autocomplete === "one-time-code" || /\b(?:otp|one[- ]?time (?:code|password)|verification code|security code|confirmation code|sms code|code we (?:sent|emailed|texted)|enter the code|2fa)\b/i.test(f.label + " " + f.name + " " + f.hint)));
	result.code = codeBox ? codeBox.label || codeBox.hint || codeBox.name : null;
	// Buttons of the form (and those outside it whose form attribute names it); for a form that is
	// the whole page, every button on it.
	const BUTTONS = "button, input[type=submit], input[type=button], input[type=image], [role=button], a[href]";
	const owned = root.tagName === "FORM" ? [...root.elements].filter((el) => el.matches(BUTTONS) && !root.contains(el)) : [];
	const nativeSubmit = (b) => (b.tagName === "BUTTON" && (b.getAttribute("type") || "submit").toLowerCase() === "submit") || (b.tagName === "INPUT" && /^(?:submit|image)$/i.test(b.type));
	result.canSubmit = root.tagName === "FORM" && [...root.elements].some((b) => nativeSubmit(b) && !b.disabled);
	// Where any control of the form may send it: every formaction of a button or input that
	// belongs to it (inside it, or outside it naming it with form=), hidden, disabled or text-less
	// ones too, before the filters below.
	if (root.tagName === "FORM") for (const el of root.elements) if (el.hasAttribute("formaction") && el.formAction) result.endpoints.push(el.formAction);
	let c = 0;
	for (const b of [...root.querySelectorAll(BUTTONS), ...owned]) {
		if (!shown(b)) continue;
		const tag = b.tagName;
		const native = tag === "A" ? "link" : tag === "INPUT" ? (b.type === "button" ? "button" : "submit") : tag === "BUTTON" ? ((b.getAttribute("type") || "submit").toLowerCase() === "button" ? "button" : (b.getAttribute("type") || "submit").toLowerCase() === "reset" ? "other" : "submit") : "button";
		// A submit button sends only the form it belongs to: outside it, or in another form, it is
		// a plain button, and a page with no <form> has no submit.
		const type = native === "submit" && (root.tagName !== "FORM" || b.form !== root) ? "button" : native;
		const text = clean(tag === "INPUT" ? b.value || b.getAttribute("aria-label") || "" : b.textContent || b.getAttribute("aria-label") || "");
		if (!text) continue;
		// Links inside the form (privacy policy, "sign in") are never a step or the submit.
		if (type === "link") continue;
		const ref = String(++c);
		b.setAttribute("data-jp-control", ref);
		result.controls.push({ ref, text: text.slice(0, 80), type });
	}
	result.errors = [...document.querySelectorAll(${JSON.stringify(WEB_ERRORS)})].filter(shown).map((e) => textOf(e)).filter(Boolean).slice(0, 10);
	return result;
})()`;

/** Page script: why the control `ref` cannot take a click (gone, or covered), else null. */
export function webCoveredScript(ref: string): string {
	return `(() => {
	const button = document.querySelector('[data-jp-control="${ref}"]');
	if (!button) return "The submit control is not on the page.";
	button.scrollIntoView({ block: "center" });
	const r = button.getBoundingClientRect();
	const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
	if (!hit || hit === button || button.contains(hit)) return null;
	return "Something covers the submit control (a banner or dialog); it was not clicked.";
})()`;
}

/** What the page shows after the submit click, for the outcome reader. */
export interface WebAfter {
	url: string;
	title: string;
	/** The form (stamped before the click) is still on the page with questions shown. */
	formShown: boolean;
	/** Visible error messages, and boxes marked invalid. */
	errors: string[];
	/** All the text the page shows, uncut. */
	text: string;
}

/** Page script: the page after the click, as a `WebAfter`. */
export const WEB_AFTER_SCRIPT = String.raw`(() => {
	const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
	const form = document.querySelector("[data-jp-form]");
	const questions = (root) => [...root.querySelectorAll("input, select, textarea")].filter((el) => el.type !== "hidden" && shown(el)).length;
	// A page that drew the form again (a new element) still shows a form.
	const formShown = (!!form && shown(form) && questions(form) > 0) || [...document.querySelectorAll("form")].some((f) => shown(f) && questions(f) >= 2);
	const errors = [...document.querySelectorAll(${JSON.stringify(WEB_ERRORS)})].filter(shown).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10);
	// A box the page or the browser marks invalid after the click is a validation error too.
	let invalid = [];
	try { invalid = [...document.querySelectorAll("[aria-invalid=true], :user-invalid")]; } catch { invalid = [...document.querySelectorAll("[aria-invalid=true]")]; }
	for (const el of invalid.filter(shown).slice(0, 5)) errors.push("A field is marked invalid: " + (el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.tagName.toLowerCase()));
	// The whole text: the outcome is checked over all of it (the model gets the start).
	return { url: location.href, title: document.title, formShown, errors, text: (document.body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() };
})()`;

/** Page script: all the text the page shows, uncut (what was there before the submit click). */
export const PAGE_TEXT_SCRIPT = `(document.body ? document.body.innerText || "" : "")`;
