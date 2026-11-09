import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * Local stand-ins for the Workable, Recruitee, Teamtailor and Personio hosted application forms,
 * modelled on the read-only inspection of 2026-11-09 (docs/form-inspection.md), with fabricated
 * companies and questions. Every POST is recorded here; nothing leaves the machine.
 *
 * What each copies from the real form, because the applier must cope with it:
 *   workable    a cookie backdrop over the form until "Decline all"; labels in `[id$=_label]`
 *               spans; radios and the privacy checkbox hidden (`aria-hidden`) inside drawn
 *               `role=radio` / `role=checkbox` controls that take the click; the CV input named
 *               only by `data-ui=resume`, with an id that changes on every load and a label that
 *               turns into "Replace file" once a file is chosen; a phone box that moves the
 *               country code into its picker
 *   recruitee   radix ids that change on every load; radios and the consent box visually hidden
 *               behind their labels; "All done!" and "You've already applied" already in the page
 *               (hidden) before submit
 *   teamtailor  Rails markup: "*Required" in labels, hidden "0" twins of each checkbox, a CV
 *               input with no name, a native form POST that lands on a thank-you page
 *   personio    "(required)" in labels, a plain location box, a CV input that is emptied once a
 *               file is chosen and lists the file instead, an invisible Turnstile field
 *
 * Variants come from the job id:
 *   unknown   adds a required question no approved answer covers
 *   captcha   a visible challenge over the form (Turnstile box, hCaptcha or reCAPTCHA frame)
 *   already   the board accepts the POST but says the candidate already applied
 *   tracker   the page loads an image from localhost, a host no run allows
 */

interface Submission {
	board: string;
	path: string;
	values: Record<string, string[]>;
	files: string[];
}

export interface MoreFixtureBoards {
	url: string;
	submissions: Submission[];
	/** POSTs whose path names this job id. */
	count(jobId: string): number;
	close(): Promise<void>;
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;font-size:14px}
label{display:block;margin:10px 0 4px}input[type=text],input[type=email],input[type=tel],textarea{width:100%;padding:6px;box-sizing:border-box}
.vh{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0)}[role=alert]{color:#b00}
.banner{background:#eef;padding:6px 10px;margin-bottom:12px;font-size:12px}`;

const TURNSTILE_BOX = (visible: boolean) =>
	`<div style="width:${visible ? 300 : 1040}px;height:${visible ? 65 : 0}px;${visible ? "border:2px solid #c00" : ""}"><div></div><input type="hidden" name="cf-turnstile-response" value=""></div>`;
const RECAPTCHA_FRAME = `<iframe title="recaptcha challenge" src="/recaptcha/api2/bframe?k=fixture" style="width:320px;height:320px;border:2px solid #c00;display:block"></iframe>`;
const HCAPTCHA_FRAME = `<iframe title="hCaptcha challenge" src="/captcha/hcaptcha.html#frame=challenge" style="width:320px;height:320px;border:2px solid #c00;display:block"></iframe>`;

const id = () => randomBytes(6).toString("base64url");

/** The board's own cookie dialog over the whole page, as Teamtailor and Recruitee show it. */
const cookieDialog = (accept: string, decline: string) =>
	`<div role="dialog" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"><div style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:12px">This website uses cookies. <button type="button" ${accept} onclick="this.closest('[role=dialog]').remove()">Accept all</button> <button type="button" ${decline} onclick="this.closest('[role=dialog]').remove()">Only the necessary</button></div></div>`;

function page(
	title: string,
	body: string,
	script: string,
	tracker: string,
): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body><div class="banner">Local fixture of a ${title} form. Submissions stay on this machine.</div>${tracker}${body}<script>${script}</script></body></html>`;
}

/** Posts the form's values (and files kept aside) to `path`, then runs `done(ok, text)`. */
const POST_JS = `async function post(form, path, extraFiles) {
	const data = new FormData(form);
	for (const [name, file] of extraFiles || []) data.append(name, file);
	const response = await fetch(path, { method: "POST", body: data });
	return { ok: response.ok, text: await response.text() };
}
function missing(form) {
	const out = [];
	for (const el of form.querySelectorAll("[required], [data-required]")) {
		if (el.type === "checkbox" || el.type === "radio") { if (![...form.querySelectorAll('[name="' + CSS.escape(el.name) + '"]')].some((g) => g.checked)) out.push(el.name); }
		else if (el.type === "file") { if (!el.files.length && !(window.KEPT && window.KEPT[el.name])) out.push(el.name || el.id); }
		else if (!el.value.trim()) out.push(el.name || el.id);
	}
	return [...new Set(out)];
}`;

function workable(v: Set<string>): string {
	const field = (
		name: string,
		label: string,
		required: boolean,
		control: string,
	) =>
		`<div><label><span>${required ? "<strong>*</strong>" : ""}<span id="${name}_label"><strong>${label}</strong></span>${required ? "" : "<span> (Optional)</span>"}</span><div>${control}</div></label></div>`;
	const text = (name: string, label: string, required = false, type = "text") =>
		field(
			name,
			label,
			required,
			`<input id="${name}" name="${name}" data-ui="${name}" type="${type}" ${required ? 'required aria-required="true"' : ""} aria-labelledby="${name}_label" value="">`,
		);
	const radios = (name: string, label: string) => {
		const labelId = `${id()}_label`;
		return `<fieldset data-ui="${name}" aria-labelledby="${labelId}"><span id="${labelId}"><strong>*</strong> ${label}</span><div role="radiogroup">${[
			"YES",
			"NO",
		]
			.map((o) => {
				const rid = id();
				return `<div data-ui="option" role="radio" aria-checked="false" tabindex="0" style="display:inline-block;padding:6px 12px;border:1px solid #888;margin-right:6px;cursor:pointer;position:relative"><label style="margin:0"><input id="${rid}" tabindex="-1" aria-hidden="true" type="radio" name="${name}" value="${o === "YES"}" required style="position:absolute;inset:0;margin:0;opacity:0;pointer-events:none"><span id="radio_label_${rid}">${o}</span></label><div style="position:absolute;inset:0"></div></div>`;
			})
			.join("")}</div></fieldset>`;
	};
	const fileId = `input_files_input_${id()}`;
	const fields = [
		'<h2>Personal information</h2><div data-ui="section-fields">',
		text("firstname", "First name", true),
		text("lastname", "Last name", true),
		text("email", "Email", true, "email"),
		field(
			"phone",
			"Phone",
			false,
			`<button type="button">+</button><input id="input_phone" name="phone" type="tel" value="">`,
		),
		"</div><h2>Profile</h2>",
		`<div><span id="cv_label"><strong>*</strong> Resume</span><div data-role="dropzone"><label for="${fileId}"><svg></svg></label><label for="${fileId}" role="button">Choose file</label> <span>or drag and drop here</span><input data-ui="resume" tabindex="-1" id="${fileId}" type="file" required aria-labelledby="cv_label" accept=".pdf" class="vh"></div></div>`,
		text("QA_501", "Why do you want to work at Acme Robotics?", true),
		"<h2>Details</h2>",
		field(
			"cover_letter",
			"Cover letter",
			false,
			`<textarea id="cover_letter" name="cover_letter" data-ui="cover_letter" aria-labelledby="cover_letter_label"></textarea>`,
		),
		text("QA_502", "What is your notice period?", true),
		radios("QA_503", "Will you require visa sponsorship?"),
		`<div data-ui="CA_601" data-input-type="select"><label><span id="CA_601_label"><strong>How did you hear about us?</strong><span> (Optional)</span></span><div><input id="input_CA_601_input" role="combobox" aria-controls="input_CA_601_listbox" aria-labelledby="CA_601_label" readonly value="" placeholder="Select an option"></div></label><input name="CA_601" aria-hidden="true" value=""><ul id="input_CA_601_listbox" role="listbox" hidden><li role="option">A friend</li><li role="option">LinkedIn</li></ul></div>`,
		...(v.has("unknown")
			? [radios("QA_504", "Are you willing to relocate to Ankara?")]
			: []),
		`<label data-ui="gdpr"><div role="checkbox" aria-checked="false" tabindex="0" aria-labelledby="checkbox_label_g" style="display:inline-block;width:18px;height:18px;border:1px solid #333;position:relative;cursor:pointer"><input tabindex="-1" aria-hidden="true" type="checkbox" name="gdpr" style="position:absolute;inset:0;margin:0;opacity:0;pointer-events:none"></div> <span id="checkbox_label_g">I have read and accept the Privacy Notice.</span></label>`,
		v.has("captcha") ? TURNSTILE_BOX(true) : "",
		`<button type="submit" data-ui="apply-button">Submit application</button>`,
	];
	const backdrop = `<div data-ui="backdrop" id="cookie-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"><div style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:12px">Cookies <button data-ui="cookie-consent-accept">Accept all</button> <button data-ui="cookie-consent-decline">Decline all</button></div></div>`;
	return page(
		"Workable",
		`<h1>Acme Robotics</h1><form data-ui="application-form" novalidate>${fields.join("")}</form>${backdrop}`,
		`${POST_JS}
for (const b of document.querySelectorAll("[data-ui^=cookie-consent]")) b.addEventListener("click", () => document.getElementById("cookie-backdrop").remove());
for (const opt of document.querySelectorAll("[data-ui=option]")) opt.addEventListener("click", () => {
	const input = opt.querySelector("input");
	for (const o of opt.parentElement.querySelectorAll("[data-ui=option]")) o.setAttribute("aria-checked", "false");
	opt.setAttribute("aria-checked", "true"); input.checked = true;
});
const combo = document.getElementById("input_CA_601_input");
const list = document.getElementById("input_CA_601_listbox");
combo.addEventListener("click", () => { list.hidden = false; });
combo.addEventListener("keydown", (e) => { if (e.key === "Escape") list.hidden = true; });
for (const o of list.querySelectorAll("[role=option]")) o.addEventListener("mousedown", (e) => { e.preventDefault(); combo.value = o.textContent; document.querySelector("[name=CA_601]").value = o.textContent; list.hidden = true; });
const box = document.querySelector("[data-ui=gdpr] [role=checkbox]");
box.addEventListener("click", (e) => { e.preventDefault(); const i = box.querySelector("input"); i.checked = !i.checked; box.setAttribute("aria-checked", String(i.checked)); });
const phone = document.getElementById("input_phone");
phone.addEventListener("input", () => { const m = phone.value.match(/^\\+(\\d{2})\\s*(.*)$/); if (m) { phone.previousElementSibling.textContent = "+" + m[1]; phone.value = m[2]; } });
const file = document.querySelector("[data-ui=resume]");
file.addEventListener("change", () => { document.querySelector('label[role=button][for="' + file.id + '"]').textContent = "Replace file"; });
const form = document.querySelector("form");
form.addEventListener("submit", async (e) => {
	e.preventDefault();
	for (const a of form.querySelectorAll("[role=alert]")) a.remove();
	const gdpr = form.querySelector("[name=gdpr]");
	const miss = missing(form).concat(gdpr.checked ? [] : ["gdpr"]);
	if (miss.length) { form.insertAdjacentHTML("afterbegin", '<p role="alert">Required: ' + miss.join(", ") + "</p>"); return; }
	// The real form uploads the CV as soon as it is chosen; here it goes along with the post.
	const r = await post(form, location.pathname + "submit", [["resume", file.files[0]]]);
	if (r.ok) form.outerHTML = '<div><h2>' + r.text + '</h2></div>';
	else form.insertAdjacentHTML("afterbegin", '<p role="alert">Something went wrong</p>');
});`,
		v.has("tracker") ? "__TRACKER__" : "",
	);
}

function recruitee(v: Set<string>): string {
	const r = id();
	const text = (name: string, label: string, type = "text") =>
		`<div><label for="input-${name}-radix-${r}">${label}<span aria-hidden="true">&nbsp;<span title="This field is required">*</span></span></label><input type="${type}" id="input-${name}-radix-${r}" required name="${name}"><div role="alert" id="input-${name}-error"></div></div>`;
	const radios = (q: string, label: string, options: string[]) =>
		`<fieldset><legend>${label} *</legend>${options
			.map(
				(o, i) =>
					`<div><input required type="radio" class="vh" id="input-${q}-radix-${r}-${i}" name="${q}" value="${o}"><label for="input-${q}-radix-${r}-${i}"><span></span><span>${o}</span></label></div>`,
			)
			.join("")}</fieldset>`;
	const file = (name: string, label: string, required: boolean) =>
		`<section><label for="input-${name}-radix-${r}">${label}${required ? '<span aria-hidden="true">&nbsp;*</span>' : ""}</label><p>Upload a file</p><div><input type="file" id="input-${name}-radix-${r}" name="${name}" ${required ? "required" : ""}></div></section>`;
	const fields = [
		"<section><fieldset><legend>My information</legend>",
		text("candidate.name", "Full name"),
		text("candidate.email", "Email address", "email"),
		text("candidate.phone", "Phone number", "tel"),
		"</fieldset></section>",
		file("candidate.cv", "CV or resume", true),
		file("candidate.coverLetterFile", "Cover letter", false),
		"<section><fieldset><legend>Questions</legend>",
		text(
			"candidate.openQuestionAnswers.11.content",
			"Why do you want to work at Acme Robotics?",
		),
		text(
			"candidate.openQuestionAnswers.12.content",
			"What is your notice period?",
		),
		radios(
			"candidate.openQuestionAnswers.13.flag",
			"Will you require visa sponsorship?",
			["Yes", "No"],
		),
		...(v.has("unknown")
			? [
					radios(
						"candidate.openQuestionAnswers.14.flag",
						"Are you willing to relocate to Ankara?",
						["Yes", "No"],
					),
				]
			: []),
		"</fieldset></section>",
		`<fieldset><legend>Your personal data</legend><div><input type="hidden" name="candidate.agreements.0.agreementId" value="7"><input required type="checkbox" class="vh" aria-labelledby="consent-${r}" name="candidate.agreements.0.consent" value="true"><div id="consent-${r}" style="cursor:pointer">I agree that Acme Robotics keeps my data for 90 days.</div></div></fieldset>`,
		v.has("captcha") ? HCAPTCHA_FRAME : "",
		`<button type="submit" data-testid="submit-application-form-button">Send</button>`,
	];
	return page(
		"Recruitee",
		`<h1>Platform Engineer</h1><form id="offer-application-form" novalidate>${fields.join("")}</form><div id="done" hidden><h3>All done!</h3><p>Your application has been sent.</p></div><div id="dup" hidden><h3>You've already applied for this job</h3></div>${cookieDialog('data-testid="agree-to-all-cookies"', 'data-testid="agree-to-selected-cookies"')}`,
		`${POST_JS}
for (const box of document.querySelectorAll("[aria-labelledby^=consent-]")) document.getElementById(box.getAttribute("aria-labelledby")).addEventListener("click", () => { box.checked = !box.checked; });
const form = document.getElementById("offer-application-form");
form.addEventListener("submit", async (e) => {
	e.preventDefault();
	for (const a of form.querySelectorAll("[role=alert]")) a.textContent = "";
	const miss = missing(form);
	if (miss.length) { form.querySelector("[role=alert]").textContent = "This field is required: " + miss.join(", "); return; }
	const r = await post(form, location.pathname + "/submit");
	if (!r.ok) { form.querySelector("[role=alert]").textContent = "Something went wrong"; return; }
	form.remove();
	document.getElementById(r.text === "duplicate" ? "dup" : "done").hidden = false;
});`,
		v.has("tracker") ? "__TRACKER__" : "",
	);
}

function teamtailor(job: string, co: string, v: Set<string>): string {
	const wrap = (inner: string) => `<div id="id_${id()}">${inner}</div>`;
	const text = (name: string, fid: string, label: string, type = "text") =>
		wrap(
			`<label for="${fid}">${label}<sup aria-hidden="true">*</sup><span class="vh">Required</span></label><input type="${type}" name="${name}" id="${fid}">`,
		);
	const bool = (n: number, label: string) =>
		`<fieldset><legend>${label}<sup aria-hidden="true">*</sup><span class="vh">Required</span></legend>${[
			"Yes",
			"No",
		]
			.map(
				(o) =>
					`<div><input id="boolean-${n}-${o}" type="radio" value="${o === "Yes"}" name="candidate[answers_attributes][${n}][boolean]"><label for="boolean-${n}-${o}">${o}</label></div>`,
			)
			.join("")}</fieldset>`;
	const check = (name: string, fid: string, label: string, required: boolean) =>
		wrap(
			`<div><input name="${name}" type="hidden" value="0"><input type="checkbox" value="1" name="${name}" id="${fid}"><label for="${fid}">${required ? "<span>Required.</span>" : ""}<p>${label}</p></label></div>`,
		);
	const fields = [
		bool(0, "Will you require visa sponsorship?"),
		wrap(
			`<label for="candidate_answers_attributes_1_text">Why do you want to work at Acme Robotics?<sup aria-hidden="true">*</sup><span class="vh">Required</span></label><textarea name="candidate[answers_attributes][1][text]" id="candidate_answers_attributes_1_text"></textarea>`,
		),
		text(
			"candidate[answers_attributes][2][text]",
			"candidate_answers_attributes_2_text",
			"What is your notice period?",
		),
		...(v.has("unknown")
			? [bool(3, "Are you willing to relocate to Ankara?")]
			: []),
		"<h2>Personal information</h2>",
		text("candidate[first_name]", "candidate_first_name", "First name"),
		text("candidate[last_name]", "candidate_last_name", "Last name"),
		text("candidate[email]", "candidate_email", "Email", "email"),
		text("candidate[phone]", "candidate_phone", "Phone", "tel"),
		wrap(
			`<label for="candidate_resume_remote_url">Upload CV<sup aria-hidden="true">*</sup><span class="vh">Required</span></label><input type="file" id="candidate_resume_remote_url" class="dz-hidden-input"><input type="hidden" name="candidate[resume_remote_url]" value="">`,
		),
		wrap(
			`<label for="candidate_cover_letter">Cover letter</label><textarea name="candidate[job_applications_attributes][0][cover_letter]" id="candidate_cover_letter"></textarea>`,
		),
		check(
			"candidate[consent_given]",
			"candidate_consent_given",
			"I have read the Privacy Policy and agree that Acme Robotics stores my data.",
			true,
		),
		check(
			"candidate[consent_given_future_jobs]",
			"candidate_consent_given_future_jobs",
			"Acme Robotics may contact me about future jobs.",
			false,
		),
		v.has("captcha") ? RECAPTCHA_FRAME : "",
		`<input type="submit" name="commit" value="Submit application">`,
	];
	return page(
		"Teamtailor",
		`<h1>Platform Engineer</h1><form id="job-application-form" method="post" enctype="multipart/form-data" action="/teamtailor/${co}/jobs/${job}/applications" novalidate><input type="hidden" name="authenticity_token" value="${id()}">${fields.join("")}</form>${cookieDialog('data-action="click->common--cookies--alert#acceptAll"', 'data-action="click->common--cookies--alert#disableAll"')}`,
		`${POST_JS}
const form = document.getElementById("job-application-form");
const cv = document.getElementById("candidate_resume_remote_url");
cv.addEventListener("change", () => { form.querySelector("[name='candidate[resume_remote_url]']").value = cv.files[0] ? "fixture://" + cv.files[0].name : ""; });
form.addEventListener("submit", (e) => {
	for (const a of form.querySelectorAll("[role=alert]")) a.remove();
	const miss = [];
	for (const label of form.querySelectorAll("label, legend")) {
		if (!/Required/.test(label.textContent)) continue;
		const box = label.closest("fieldset, div[id^=id_]");
		const inputs = [...box.querySelectorAll("input:not([type=hidden]), textarea")];
		if (!inputs.some((i) => i.type === "file" ? i.files.length : i.type === "radio" || i.type === "checkbox" ? i.checked : i.value.trim())) miss.push(label.textContent.trim().slice(0, 30));
	}
	if (miss.length) { e.preventDefault(); form.insertAdjacentHTML("afterbegin", '<p role="alert">Please fill in: ' + miss.join(", ") + "</p>"); return; }
	// The real form uploads the CV first (Dropzone) and posts its URL; here the file goes along.
	cv.name = "candidate[resume]";
});`,
		v.has("tracker") ? "__TRACKER__" : "",
	);
}

function personio(v: Set<string>): string {
	const field = (
		name: string,
		label: string,
		required: boolean,
		placeholder = label,
	) =>
		`<div><label for="field-${name}">${label}${required ? '<span aria-hidden="true">*</span><span> (required)</span>' : ""}</label><div><input id="field-${name}" type="text" placeholder="${placeholder}" name="${name}" value=""><div role="alert"></div></div></div>`;
	const fields = [
		`<fieldset><div role="group" aria-labelledby="name-group-label"><span id="name-group-label">Name<span aria-hidden="true">*</span><span> (required)</span></span><div><div><label for="field-first_name">First</label><input id="field-first_name" type="text" placeholder="First" name="first_name" value=""></div><div><label for="field-last_name">Last</label><input id="field-last_name" type="text" placeholder="Last" name="last_name" value=""></div></div></div></fieldset>`,
		field("email", "Email", true),
		field("phone", "Phone", true),
		field("location", "Location", true),
		field("custom_attribute_21", "What is your notice period?", true),
		field(
			"custom_attribute_22",
			"Why do you want to work at Acme Robotics?",
			true,
		),
		field("custom_attribute_25", "Will you require visa sponsorship?", true),
		...(v.has("unknown")
			? [
					field(
						"custom_attribute_23",
						"Are you willing to relocate to Ankara?",
						true,
					),
				]
			: []),
		field("custom_attribute_24", "Pronouns", false),
		`<h3>Documents</h3><div role="group" aria-labelledby="doc-label-cv"><div id="doc-label-cv">CV<span aria-hidden="true">*</span><span> (required)</span></div><div><div role="list" aria-label="Selected files for CV"></div><button type="button">Add file</button><input id="doc-input-cv" type="file" multiple aria-label="Upload CV" name="documents.cv" class="vh"></div></div>`,
		`<div role="group" aria-labelledby="doc-label-other"><div id="doc-label-other">Other<span> (Optional)</span></div><div><div role="list"></div><button type="button">Add file</button><input id="doc-input-other" type="file" multiple aria-label="Upload Other" name="documents.other" class="vh"></div></div>`,
		TURNSTILE_BOX(v.has("captcha")),
		`<button type="submit">Submit Application</button>`,
	];
	return page(
		"Personio",
		`<h1>Platform Engineer</h1><form class="DynamicForm_formContainer__fx" novalidate>${fields.join("")}</form>`,
		`${POST_JS}
window.KEPT = {};
for (const input of document.querySelectorAll("input[type=file]")) input.addEventListener("change", () => {
	const list = input.parentElement.querySelector("[role=list]");
	for (const f of input.files) { (window.KEPT[input.name] ||= []).push(f); list.insertAdjacentHTML("beforeend", '<div role="listitem"><span>' + f.name + '</span><button type="button">×</button></div>'); }
	input.value = "";
});
const form = document.querySelector("form");
form.addEventListener("submit", async (e) => {
	e.preventDefault();
	for (const a of form.querySelectorAll("[role=alert]")) a.textContent = "";
	const miss = [];
	for (const label of form.querySelectorAll("label")) if (/required/.test(label.textContent)) { const i = document.getElementById(label.htmlFor); if (!i.value.trim()) miss.push(i.name); }
	if (!(window.KEPT["documents.cv"] || []).length) miss.push("documents.cv");
	if (miss.length) { form.querySelector("[role=alert]").textContent = "Required: " + miss.join(", "); return; }
	const kept = Object.entries(window.KEPT).flatMap(([n, fs]) => fs.map((f) => [n, f]));
	const r = await post(form, location.pathname + "/submit", kept);
	if (r.ok) form.outerHTML = "<h2>" + r.text + "</h2>";
	else form.querySelector("[role=alert]").textContent = "Something went wrong";
});`,
		v.has("tracker") ? "__TRACKER__" : "",
	);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("latin1");
}

const VARIANTS = ["unknown", "captcha", "already", "tracker"];

/** Records a POST and answers it the way the board does (a thank-you or a duplicate). */
function parsePost(board: string, path: string, body: string): Submission {
	const values: Record<string, string[]> = {};
	for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g))
		values[m[1] ?? ""] = [...(values[m[1] ?? ""] ?? []), m[2] ?? ""];
	const files = [...body.matchAll(/name="([^"]+)"; filename="([^"]*)"/g)]
		.filter((m) => m[2])
		.map((m) => `${m[1]}=${m[2]}`);
	return { board, path, values, files };
}

function postAnswer(
	board: string,
	co: string,
	job: string,
	already: boolean,
): { status: number; headers: Record<string, string>; body: string } {
	if (board === "teamtailor")
		return {
			status: 303,
			headers: {
				location: `/teamtailor/${co}/jobs/${job}/applications/${already ? "duplicate" : "thank-you"}`,
			},
			body: "",
		};
	const text =
		board === "recruitee"
			? already
				? "duplicate"
				: "ok"
			: already
				? "You have already applied for this job."
				: "Thank you for applying! Your application has been submitted.";
	return { status: 200, headers: { "content-type": "text/plain" }, body: text };
}

/** The page a GET asks for, or null (404). */
function pageFor(
	parts: string[],
	job: string,
	variant: Set<string>,
): string | null {
	const [board = "", co = ""] = parts;
	const last = parts.at(-1);
	if (board === "workable" && parts[4] === "apply") return workable(variant);
	if (board === "recruitee" && parts[4] === "c" && last === "new")
		return recruitee(variant);
	if (board === "personio" && parts[4] === "apply") return personio(variant);
	if (board !== "teamtailor") return null;
	if (last === "new") return teamtailor(job, co, variant);
	if (last === "thank-you")
		return page(
			"Teamtailor",
			"<h1>Thank you for your application!</h1><p>We will be in touch.</p>",
			"",
			"",
		);
	if (last === "duplicate")
		return page(
			"Teamtailor",
			"<h1>Thank you for your application</h1><p>You have already applied for this job.</p>",
			"",
			"",
		);
	return null;
}

/** Starts the four fixture boards on 127.0.0.1 (port 0 = any free port). */
export async function startMoreFixtureBoards(): Promise<MoreFixtureBoards> {
	const submissions: Submission[] = [];
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const parts = url.pathname.split("/").filter(Boolean);
		const [board = "", co = ""] = parts;
		const html = (status: number, markup: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			res.end(markup);
		};
		if (/^\/(recaptcha|captcha)\//.test(url.pathname))
			return html(200, "<p>Select all images with traffic lights.</p>");
		if (url.pathname.startsWith("/__tracker")) return html(200, "");
		// The job id: workable /j/<id>, recruitee /o/<slug>, teamtailor /jobs/<tail>, personio /job/<id>.
		const job =
			parts[
				parts.findIndex((p) => ["j", "o", "jobs", "job"].includes(p)) + 1
			] ?? "";
		const variant = new Set(VARIANTS.filter((v) => job.includes(v)));
		if (req.method === "POST") {
			submissions.push(parsePost(board, url.pathname, await readBody(req)));
			const answer = postAnswer(board, co, job, variant.has("already"));
			res.writeHead(answer.status, answer.headers);
			res.end(answer.body);
			return;
		}
		const port = (server.address() as { port: number }).port;
		const tracker = `<img alt="" src="http://localhost:${port}/__tracker.gif" width="1" height="1">`;
		const body = pageFor(parts, job, variant);
		html(
			body ? 200 : 404,
			body ? body.replace("__TRACKER__", tracker) : "<h1>Not found</h1>",
		);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		submissions,
		count: (jobId) =>
			submissions.filter((s) => s.path.includes(`/${jobId}/`)).length,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.();
				server.close(() => done());
			}),
	};
}
