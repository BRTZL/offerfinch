import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

/**
 * Local stand-ins for employers' own application forms (the "web" board, plan step 6), on a
 * fabricated employer. Nothing leaves the machine; every POST is counted. Forms live at
 * `/web/<variant>/apply` on 127.0.0.1; tests allow only that host, so `localhost` is "another
 * site". Control ids change on every load (as many sites' do), so keys must come from names.
 *
 *   single        one page: name, email, phone, a named box with no label (only text near it), location,
 *                 two questions, a CV upload, an optional newsletter box and a hidden honeypot;
 *                 a native POST that redirects to /thanks
 *   two-step      step 1 (contact) shown, step 2 (questions, CV) kept hidden; "Next" checks step 1
 *                 and shows step 2; the submit posts with fetch and replaces the form with a thank-you
 *   unknown       single, plus a required "driving licence" question no approved answer covers
 *   login         "Sign in to apply": an email and a password box, no application form
 *   code          single, plus "Enter the code we sent to your email" (one-time-code)
 *   ambiguous     single; the POST answers on the same URL with "Your request has been noted."
 *   stays         the POST succeeds but the form stays, a "Thank you for applying!" banner above it
 *   upload-away   single; choosing the CV posts it to localhost at once
 *   frame-away    the form is in a frame from localhost
 *   framed        the single form in a frame of the same site
 *   nameless      no control has a name (a script framework's form); from the second load on an
 *                 unlabelled box appears above the others; posts every box by its label as JSON
 *   swapped       full name and email; from the second load on an optional "Promo code" box takes
 *                 the email box's place; a native POST that redirects to /thanks
 *   shifted       full name, then "Contact details" with an unlabelled email and phone box; from
 *                 the second load on an unlabelled box appears first in that group; posts as JSON
 *   contact-swap  full name, then "Contact details" with an email and a phone box that have no name, id
 *                 or label; from the second load on the two trade places; posts as JSON
 *   adds-unlabelled email and full name, named and labelled; from the second load on an optional box
 *                 with no name, id or label appears
 *   twin-keys     full name, and an email and a phone box that share one name ("contact")
 *   preview       email and full name, help text already saying "Thank you for applying!"; the only
 *                 button changes the query string and sends nothing
 *   echo          the same help text above the form; the submit posts and swaps the form for "Saved."
 *   posting-next  email and full name shown, phone and location in a hidden step; its "Next" is a
 *                 native submit button: clicking it posts the first step (and redirects to /thanks)
 *   formless      name and email with no <form> around them, and a lone untyped "Go" button
 *   script-button email and full name; the only button is a plain one ("Submit application") whose
 *                 script posts the form and shows a thank-you
 *   form-attr     email and full name; the submit button sits after the form, naming it with `form=`
 *   telemetry     email and full name; the submit only posts "event=click" to /web/telemetry/telemetry,
 *                 then the page shows a thank-you
 *   rejected      the same, posting the application; the server answers HTTP 500
 *   json          the same, posting the application as JSON ({"candidate": {...}})
 *   silent        name and email; the submit sends nothing and swaps the form for a thank-you
 *   hidden-away   email and full name with the form's own submit button, plus a submit button kept
 *                 hidden (display:none) whose formaction is on localhost
 *   textless-away the same, with a visible submit button that has no text and a formaction on localhost
 *   outside-away  the same, with a hidden button after the form that names it with form= and posts to
 *                 localhost
 *   image-away    the same, with a text-less image submit (`<input type=image>`, which `form.elements`
 *                 leaves out) whose formaction is on localhost
 *   image-outside-away the same, with a hidden image submit after the form that names it with form=
 *                 and posts to localhost
 *   preclick      email and full name; once both are typed the page autosaves the whole form to
 *                 /web/preclick/autosave (its answer held until the next POST arrives); the submit
 *                 only posts "event=click", then the page shows a thank-you
 *   presave       the same autosave; the submit then posts the whole application to /web/presave/apply
 *   unanswered    email and full name; the submit posts to /web/unanswered/hang (never answered),
 *                 then the whole application to /web/unanswered/apply
 *   later-fetch   email and full name; the submit posts "event=click", then a telemetry post carrying
 *                 both values as JSON, then the page shows a thank-you
 *   later-native  email and full name, posted natively; on submit the page strips the boxes' names and
 *                 posts only "event=click"; the answer's script posts both values (kept in
 *                 sessionStorage) to /web/later-native/telemetry and shows a thank-you
 *   native-get    email and full name in a native GET form to /web/native-get/sent, which thanks
 *   error200      email and full name posted natively; HTTP 200 with "Application could not be
 *                 submitted" above "Thank you for applying!"
 *   error-hidden  the same; HTTP 200 showing only "Thank you for applying!", the refusal kept hidden
 *   invalid-after email and full name; the submit posts the application, moves the path, marks the
 *                 email box invalid and shows "Thank you for applying!" above the form
 *   assets        name, email and location; loads a logo from localhost, and on input asks localhost
 *                 for images whose paths carry pieces of what was typed (base64 pieces, the first word)
 */

export interface WebSubmission {
	variant: string;
	host: string;
	path: string;
	fields: string[];
	body: string;
}

export interface FixtureWebForms {
	url: string;
	server: Server;
	submissions: WebSubmission[];
	/** POSTs to the given variant's apply or submit path on 127.0.0.1. */
	count(variant: string): number;
	/** Every request that reached localhost (the other site). */
	away: { method: string; path: string }[];
	close(): Promise<void>;
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:680px;margin:24px auto;font-size:14px}
label,legend{display:block;font-weight:600;margin:12px 0 4px}input[type=text],input[type=email],input[type=tel],input[type=url],textarea,select{width:100%;padding:6px;box-sizing:border-box}
.note{background:#eef;padding:6px 10px;font-size:12px}.hint{font-weight:600;margin:12px 0 4px}.thanks{background:#efe;padding:10px}`;

function page(body: string, script = "", away = ""): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Robotics careers</title><style>${STYLE}</style><script>window.AWAY_ORIGIN=${JSON.stringify(away)};</script></head><body><p class="note">Local fixture of an employer's application form. Submissions stay on this machine.</p>${body}<script>${script}</script></body></html>`;
}

const id = (name: string) => `f-${randomUUID().slice(0, 8)}-${name}`;

/** Labelled text box; `for` points at a per-load id. */
function text(
	label: string,
	name: string,
	{ required = false, type = "text" } = {},
): string {
	const i = id(name);
	return `<div><label for="${i}">${label}${required ? " *" : ""}</label><input id="${i}" name="${name}" type="${type}"${required ? " required" : ""}></div>`;
}

function contact(): string {
	return [
		text("Full name", "full_name", { required: true }),
		text("Email address", "email", { required: true, type: "email" }),
		text("Phone number", "phone", { type: "tel" }),
	].join("");
}

function questions(): string {
	const why = id("why");
	const cv = id("cv");
	return `<div><label for="${why}">Why do you want to work at Acme Robotics? *</label><textarea id="${why}" name="why" required></textarea></div>
${text("What is your notice period?", "notice", { required: true })}
<div><label for="${cv}">Resume / CV *</label><input id="${cv}" name="cv" type="file" accept=".pdf" required> <button type="button" onclick="document.getElementById('${cv}').click()">Upload file</button></div>`;
}

/** A box no label names: only the text beside it says what it is (and its name, when it has one). */
function unlabelled(name = ""): string {
	return `<div><div class="hint">Your LinkedIn profile</div><input id="${id("li")}"${name ? ` name="${name}"` : ""} type="url"></div>`;
}

function singleBody(variant: string): string {
	const otp = id("otp");
	const extra =
		variant === "unknown"
			? `<div><label for="dl">Do you hold a valid driving licence? *</label><select id="dl" name="driving_licence" required><option value="">Choose</option><option>Yes</option><option>No</option></select></div>`
			: variant === "code"
				? `<div><label for="${otp}">Enter the code we sent to your email</label><input id="${otp}" name="otp" autocomplete="one-time-code"></div>`
				: "";
	return `<h1>Robotics Engineer at Acme Robotics</h1>
<form id="apply" method="post" action="/web/${variant}/apply" enctype="multipart/form-data">
<h2>Your details</h2>
${contact()}
${unlabelled("profile_url")}
${text("Where are you based?", "location")}
<h2>Questions</h2>
${questions()}
${extra}
<div><label><input type="checkbox" name="news" value="yes"> Send me news about future openings</label></div>
<div style="display:none"><input name="company_website" type="text" tabindex="-1" autocomplete="off"></div>
<p><button type="submit">Submit application</button></p>
</form>`;
}

const UPLOAD_AWAY = `document.querySelector('input[type=file]').addEventListener('change', (e) => { const d = new FormData(); d.append('cv', e.target.files[0]); fetch(window.AWAY_ORIGIN + '/web/upload-away/upload', { method: 'POST', body: d, mode: 'no-cors' }).catch(() => {}); });`;

function twoStepBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1>
<form id="apply">
<div id="step-1"><h2>Step 1 of 2: your details</h2>${contact()}<p><button type="button" id="next">Next</button></p></div>
<div id="step-2" style="display:none"><h2>Step 2 of 2: questions</h2>${questions()}<p><button type="button" id="back">Back</button> <button type="submit">Submit application</button></p></div>
</form>`;
}

const TWO_STEP = `const form = document.getElementById('apply');
document.getElementById('next').addEventListener('click', () => {
	const missing = [...document.querySelectorAll('#step-1 [required]')].filter((el) => !el.value.trim());
	if (missing.length) { form.insertAdjacentHTML('afterbegin', '<p role="alert">Fill in the required fields.</p>'); return; }
	for (const a of document.querySelectorAll('[role=alert]')) a.remove();
	document.getElementById('step-1').style.display = 'none';
	document.getElementById('step-2').style.display = '';
});
document.getElementById('back').addEventListener('click', () => { document.getElementById('step-2').style.display = 'none'; document.getElementById('step-1').style.display = ''; });
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	const res = await fetch('/web/two-step/submit', { method: 'POST', body: new FormData(form) });
	if (res.ok) form.outerHTML = '<div class="thanks"><h2>Thank you for your application!</h2><p>We will review it and reply by email.</p></div>';
});`;

const STAYS = `const form = document.getElementById('apply');
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	await fetch('/web/stays/apply', { method: 'POST', body: new FormData(form) });
	form.insertAdjacentHTML('beforebegin', '<p class="thanks">Thank you for applying!</p>');
});`;

/**
 * A form drawn by a script framework: no control has a name, ids change on every load. From the
 * second load on, an optional box with no label appears above the others.
 */
function namelessBody(extra: boolean): string {
	const box = (label: string, type = "text", required = false) => {
		const i = id("n");
		return `<div><label for="${i}">${label}${required ? " *" : ""}</label><input id="${i}" type="${type}"${required ? " required" : ""}></div>`;
	};
	const why = id("n");
	const cv = id("n");
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply">
${extra ? `<div><div class="hint">Promo code</div><input id="${id("n")}" type="text"></div>` : ""}
${box("Full name", "text", true)}${box("Email address", "email", true)}
${unlabelled()}
<div><label for="${why}">Why do you want to work at Acme Robotics? *</label><textarea id="${why}" required></textarea></div>
${box("What is your notice period?", "text", true)}
<div><label for="${cv}">Resume / CV *</label><input id="${cv}" type="file" required></div>
<p><button type="submit">Submit application</button></p></form>`;
}

/** Full name and email; from the second load on, an optional "Promo code" in the email's place. */
function swappedBody(changed: boolean): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1>
<form id="apply" method="post" action="/web/swapped/apply">
${changed ? text("Promo code", "promo") : text("Email address", "email", { type: "email" })}
${text("Full name", "full_name", { required: true })}
<p><button type="submit">Submit application</button></p>
</form>`;
}

/** Two unlabelled boxes under one text; from the second load on, a third one before them. */
function shiftedBody(inserted: boolean): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply">
${text("Full name", "full_name", { required: true })}
<div><div class="hint">Contact details</div>${inserted ? `<input data-origin="inserted" type="text">` : ""}<input data-origin="email" type="email"><input data-origin="phone" type="tel"></div>
<p><button type="submit">Submit application</button></p></form>`;
}

/**
 * Codex's re-review case: under "Contact details" an email and a phone box with no name, id or
 * label; from the second load on they trade places. The form's own submit posts them as JSON.
 */
function contactSwapBody(swapped: boolean): string {
	const boxes = [
		`<input data-origin="email" type="text">`,
		`<input data-origin="phone" type="text">`,
	];
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply">
${text("Full name", "full_name", { required: true })}
<div><div class="hint">Contact details</div>${(swapped ? boxes.reverse() : boxes).join("")}</div>
<p><button type="submit">Submit application</button></p></form>`;
}

/** Labelled and named on the first load; from the second on, an optional box with nothing of its own. */
function addsUnlabelledBody(added: boolean): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply" method="post" action="/web/adds-unlabelled/apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
${added ? `<div><div class="hint">Promo code</div><input type="text"></div>` : ""}
<p><button type="submit">Submit application</button></p></form>`;
}

/** Two boxes with one name: which one is the email and which the phone only their labels say. */
function twinKeysBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply" method="post" action="/web/twin-keys/apply">
${text("Full name", "full_name", { required: true })}${text("Email address", "contact", { type: "email" })}${text("Phone number", "contact", { type: "tel" })}
<p><button type="submit">Submit application</button></p></form>`;
}

const SHIFTED = `const form = document.getElementById('apply');
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	const out = {};
	for (const el of form.querySelectorAll('input')) out[el.dataset.origin || el.name] = el.value;
	const res = await fetch('/web/shifted/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
	if (res.ok) form.outerHTML = '<div class="thanks"><h2>Thank you for your application!</h2></div>';
});`;

/** Help text that already holds confirmation words, before anything is sent. */
const ALREADY_THANKED = `<p class="note">When it is done you will see: Thank you for applying!</p>`;

function previewBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1>${ALREADY_THANKED}<form id="apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="button" onclick="history.pushState({}, '', '?preview=1')">Submit application</button></p></form>`;
}

function echoBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1>${ALREADY_THANKED}<form id="apply" method="post" action="/web/echo/apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="submit">Submit application</button></p></form>`;
}

const ECHO = `const form = document.getElementById('apply');
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	const res = await fetch('/web/echo/apply', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
	if (res.ok) form.outerHTML = '<p>Saved.</p>';
});`;

/** A "Next" that is the form's own submit button: the first step leaves with it. */
function postingNextBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply" method="post" action="/web/posting-next/apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<div style="display:none">${text("Phone number", "phone", { type: "tel" })}${text("Where are you based?", "location")}</div>
<p><button>Next</button></p></form>`;
}

function formlessBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><div>
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button>Go</button></p></div>`;
}

/** Codex's re-review case: the only button is a plain one; its script posts the form. */
function scriptButtonBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="button" id="send">Submit application</button></p></form>`;
}

const SCRIPT_BUTTON = `document.getElementById('send').addEventListener('click', async () => {
	const form = document.getElementById('apply');
	const res = await fetch('/web/script-button/apply', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
	if (res.ok) form.outerHTML = '<div class="thanks"><h2>Thank you for applying!</h2></div>';
});`;

/** The submit button sits outside the form and names it with its form attribute. */
function formAttrBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply" method="post" action="/web/form-attr/apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
</form><p><button type="submit" form="apply">Submit application</button></p>`;
}

/** Email and full name, posted natively to the form's own page (`later-native`, `native-get`). */
function nativeBody(variant: string): string {
	const method =
		variant === "native-get"
			? `method="get" action="/web/${variant}/sent"`
			: `method="post" action="/web/${variant}/apply"`;
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply" ${method}>
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="submit">Submit application</button></p></form>`;
}

/** On submit: keeps the answers aside, strips the boxes' names and posts only "event=click". */
const LATER_NATIVE = `const form = document.getElementById('apply');
form.addEventListener('submit', () => {
	sessionStorage.payload = JSON.stringify(Object.fromEntries(new FormData(form)));
	for (const box of form.querySelectorAll('input')) box.removeAttribute('name');
	const click = document.createElement('input');
	click.type = 'hidden'; click.name = 'event'; click.value = 'click';
	form.append(click);
});`;

/** The answer to `later-native`'s post: its script sends the kept answers, then thanks. */
const LATER_NATIVE_ANSWER = `fetch('/web/later-native/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: sessionStorage.payload }).then(() => { document.body.insertAdjacentHTML('beforeend', '<h2>Thank you for applying!</h2>'); });`;

/** Email and full name with the form's own submit button, and another one that sends to `away`. */
function awayButtonBody(variant: string, away: string): string {
	const to = `${away}/web/${variant}/collect`;
	const inside =
		variant === "hidden-away"
			? `<button type="submit" style="display:none" formaction="${to}">Send</button>`
			: variant === "textless-away"
				? `<button type="submit" formaction="${to}" aria-hidden="true"></button>`
				: variant === "image-away"
					? `<input type="image" alt="" formaction="${to}">`
					: "";
	const outside =
		variant === "outside-away"
			? `<button type="submit" form="apply" hidden formaction="${to}">Send</button>`
			: variant === "image-outside-away"
				? `<input type="image" form="apply" hidden alt="Send" formaction="${to}">`
				: "";
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply" method="post" action="/web/${variant}/apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="submit">Submit application</button>${inside}</p></form>${outside}`;
}

/**
 * Email and full name with the form's own submit button; on submit the page's script sends what
 * `SENDS[variant]` says, then swaps the form for a thank-you, whatever the answer.
 */
function scriptedBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="submit">Submit application</button></p></form>`;
}

const SENDS: Record<string, string> = {
	// The application, after which the page says the email is invalid (and thanks anyway).
	"invalid-after": `fetch('/web/invalid-after/apply', { method: 'POST', body: new URLSearchParams(new FormData(form)) }).then(() => { history.pushState(null, '', '/web/invalid-after/done'); form.querySelector('[name=email]').setAttribute('aria-invalid', 'true'); form.insertAdjacentHTML('beforebegin', '<p class="thanks">Thank you for applying!</p>'); })`,
	// Codex's third pass: the application went before the click (an autosave); the click sent
	// only a click event.
	preclick: `fetch('/web/preclick/telemetry', { method: 'POST', body: 'event=click' })`,
	// The same autosave, then the click posts the whole application too: two requests carry it.
	presave: `fetch('/web/presave/apply', { method: 'POST', body: new URLSearchParams(new FormData(form)) })`,
	// The click starts a post that is never answered, then the application.
	unanswered: `Promise.resolve(void fetch('/web/unanswered/hang', { method: 'POST', body: 'event=view' }).catch(() => {})).then(() => fetch('/web/unanswered/apply', { method: 'POST', body: new URLSearchParams(new FormData(form)) }))`,
	// The click sent a click event, then a telemetry post that happens to carry the answers.
	"later-fetch": `fetch('/web/later-fetch/telemetry', { method: 'POST', body: 'event=click' }).then(() => fetch('/web/later-fetch/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }))`,
	// Codex's re-review case: a click event to the form's own host, nothing of the application.
	telemetry: `fetch('/web/telemetry/telemetry', { method: 'POST', body: 'event=click' })`,
	// The application, refused by the server (HTTP 500).
	rejected: `fetch('/web/rejected/apply', { method: 'POST', body: new URLSearchParams(new FormData(form)) })`,
	// The application as JSON.
	json: `fetch('/web/json/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate: Object.fromEntries(new FormData(form)) }) })`,
};

/** Once every box is filled, the whole form is saved (before any click). */
const AUTOSAVE = `form.addEventListener('input', () => {
	const boxes = [...form.querySelectorAll('input')];
	if (!form.dataset.saved && boxes.every((b) => b.value)) {
		form.dataset.saved = '1';
		fetch(location.pathname.replace(/apply$/, 'autosave'), { method: 'POST', body: new URLSearchParams(new FormData(form)) }).catch(() => {});
	}
});`;

function scripted(variant: string): string {
	return `const form = document.getElementById('apply');
${variant === "preclick" || variant === "presave" ? AUTOSAVE : ""}
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	await ${SENDS[variant]}.catch(() => {});
	${variant === "invalid-after" ? "return;" : ""}
	form.outerHTML = '<div class="thanks"><h2>Thank you for applying!</h2></div>';
});`;
}

function silentBody(): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><form id="apply">
${text("Email address", "email", { type: "email" })}${text("Full name", "full_name", { required: true })}
<p><button type="submit">Submit application</button></p></form>`;
}

const SILENT = `const form = document.getElementById('apply');
form.addEventListener('submit', (e) => {
	e.preventDefault();
	form.outerHTML = '<div class="thanks"><h2>Thank you for applying!</h2></div>';
});`;

function assetsBody(away: string): string {
	return `<h1>Robotics Engineer at Acme Robotics</h1><img src="${away}/web/assets/logo.png" alt="">
<form id="apply" method="post" action="/web/assets/apply">
${text("Full name", "full_name", { required: true })}${text("Email address", "email", { type: "email" })}${text("Where are you based?", "location")}
<p><button type="submit">Submit application</button></p></form>`;
}

/** Each typed value leaves in pieces no single one of which is the value: only by path. */
const ASSETS = `const at = (path) => { new Image().src = window.AWAY_ORIGIN + '/web/assets/' + path + '.png'; };
const b64 = (t) => btoa(t).replace(/=+$/, '');
for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => {
	const v = el.value;
	at(b64(v.slice(0, 8)));
	at(b64(v.slice(8)));
	at(encodeURIComponent(v.split(/[ ,@]/)[0]));
	at('logo');
});`;

/** Posts every box as "label or nearby text = value", as the page shows it. */
const NAMELESS = `const form = document.getElementById('apply');
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	const out = {};
	for (const el of form.querySelectorAll('input, textarea')) {
		const label = document.querySelector('label[for="' + el.id + '"]');
		const name = (label ? label.textContent : el.previousElementSibling ? el.previousElementSibling.textContent : '').replace('*', '').trim();
		out[name] = el.type === 'file' ? [...el.files].map((f) => f.name).join(',') : el.value;
	}
	const res = await fetch('/web/nameless/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out) });
	if (res.ok) form.outerHTML = '<div class="thanks"><h2>Thank you for your application!</h2></div>';
});`;

/** How a variant answers a POST: the same-URL page, JSON for script posts, else a redirect. */
function postAnswer(
	variant: string,
	action: string,
): { status: number; headers: Record<string, string>; body: string } {
	if (variant === "rejected")
		return {
			status: 500,
			headers: { "content-type": "application/json" },
			body: '{"ok":false}',
		};
	if (variant === "later-native" && action === "apply")
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: page("<h1>Acme Robotics</h1>", LATER_NATIVE_ANSWER),
		};
	if (variant === "error200" || variant === "error-hidden")
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: page(
				variant === "error200"
					? "<h1>Application could not be submitted</h1><p>Thank you for applying!</p>"
					: '<h1>Thank you for applying!</h1><div style="display:none">Application could not be submitted. Please try again.</div>',
			),
		};
	if (variant === "ambiguous")
		return {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
			body: page("<h1>Acme Robotics</h1><p>Your request has been noted.</p>"),
		};
	if (
		[
			"two-step",
			"stays",
			"nameless",
			"shifted",
			"contact-swap",
			"echo",
			"script-button",
			"telemetry",
			"json",
			"preclick",
			"presave",
			"unanswered",
			"later-fetch",
			"later-native",
			"invalid-after",
		].includes(variant) ||
		action === "upload"
	)
		return {
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"ok":true}',
		};
	return {
		status: 303,
		headers: { location: `/web/${variant}/thanks` },
		body: "",
	};
}

/** The page of a variant's form (its `load`-th load), or null for an unknown variant. */
function formPage(
	variant: string,
	awayOrigin: string,
	load: number,
): string | null {
	switch (variant) {
		case "single":
		case "unknown":
		case "code":
		case "ambiguous":
			return page(singleBody(variant));
		case "stays":
			return page(singleBody(variant), STAYS);
		case "upload-away":
			return page(singleBody(variant), UPLOAD_AWAY, awayOrigin);
		case "two-step":
			return page(twoStepBody(), TWO_STEP);
		case "login":
			return page(
				`<h1>Sign in to apply</h1><form method="post" action="/web/login/session"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>`,
			);
		case "frame-away":
			return page(
				`<h1>Apply</h1><iframe src="${awayOrigin}/web/single/apply" style="width:640px;height:900px;border:0"></iframe>`,
			);
		case "framed":
			return page(
				`<h1>Apply</h1><iframe src="/web/single/apply" style="width:640px;height:1200px;border:0"></iframe>`,
			);
		case "nameless":
			return page(namelessBody(load > 1), NAMELESS);
		case "swapped":
			return page(swappedBody(load > 1));
		case "shifted":
			return page(shiftedBody(load > 1), SHIFTED);
		case "contact-swap":
			return page(
				contactSwapBody(load > 1),
				SHIFTED.replace("/shifted/", "/contact-swap/"),
			);
		case "adds-unlabelled":
			return page(addsUnlabelledBody(load > 1));
		case "twin-keys":
			return page(twinKeysBody());
		case "preview":
			return page(previewBody());
		case "echo":
			return page(echoBody(), ECHO);
		case "posting-next":
			return page(postingNextBody());
		case "formless":
			return page(formlessBody());
		case "silent":
			return page(silentBody(), SILENT);
		case "telemetry":
		case "rejected":
		case "json":
		case "preclick":
		case "presave":
		case "unanswered":
		case "later-fetch":
			return page(scriptedBody(), scripted(variant));
		case "later-native":
			return page(nativeBody(variant), LATER_NATIVE);
		case "native-get":
		case "error200":
		case "error-hidden":
			return page(nativeBody(variant));
		case "invalid-after":
			return page(scriptedBody(), scripted(variant));
		case "script-button":
			return page(scriptButtonBody(), SCRIPT_BUTTON);
		case "form-attr":
			return page(formAttrBody());
		case "hidden-away":
		case "textless-away":
		case "outside-away":
		case "image-away":
		case "image-outside-away":
			return page(awayButtonBody(variant, awayOrigin));
		case "assets":
			return page(assetsBody(awayOrigin), ASSETS, awayOrigin);
		default:
			return null;
	}
}

async function bodyOf(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("latin1");
}

/**
 * Answers a POST (`postAnswer`). `unanswered`'s hang is never answered: it is kept in `hanging`
 * and settled (HTTP 503) when the fixture closes. An autosave (`preclick`, `presave`) is answered only once the next post
 * arrives, after the click; every other post answers at once and releases those held.
 */
function answerPost(
	res: ServerResponse,
	variant: string,
	action: string,
	held: (() => void)[],
	hanging: ServerResponse[],
): void {
	const answer = postAnswer(variant, action);
	const reply = () => {
		res.writeHead(answer.status, answer.headers);
		res.end(answer.body);
	};
	if (variant === "unanswered" && action === "hang") {
		hanging.push(res);
		return;
	}
	if (action === "autosave") {
		held.push(reply);
		return;
	}
	reply();
	for (const release of held.splice(0)) release();
}

export async function startFixtureWebForms(): Promise<FixtureWebForms> {
	const submissions: WebSubmission[] = [];
	const away: { method: string; path: string }[] = [];
	const loads = new Map<string, number>();
	const held: (() => void)[] = [];
	const hanging: ServerResponse[] = [];
	const server = createServer(async (req, res) => {
		const host = (req.headers.host ?? "").split(":")[0] ?? "";
		const port = (req.headers.host ?? "").split(":")[1] ?? "";
		const url = new URL(req.url ?? "/", "http://fixture");
		const awayOrigin = `http://localhost:${port}`;
		const html = (status: number, content: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			res.end(content);
		};
		if (host === "localhost")
			away.push({ method: req.method ?? "", path: url.pathname });
		const [, root, variant = "", action = ""] = url.pathname.split("/");
		if (root !== "web") return html(404, page("<h1>Not found</h1>"));
		if (req.method === "POST") {
			const body = await bodyOf(req);
			submissions.push({
				variant,
				host,
				path: url.pathname,
				fields: [...body.matchAll(/name="([^"]+)"/g)].map((m) => m[1] ?? ""),
				body,
			});
			return answerPost(res, variant, action, held, hanging);
		}
		if (action === "thanks" || (variant === "native-get" && action === "sent"))
			return html(
				200,
				page(
					"<h1>Thank you for applying to Acme Robotics</h1><p>We have received your application and will reply by email.</p>",
				),
			);
		if (action !== "apply") return html(404, page("<h1>Not found</h1>"));
		const load = (loads.get(variant) ?? 0) + 1;
		loads.set(variant, load);
		const form = formPage(variant, awayOrigin, load);
		return form ? html(200, form) : html(404, page("<h1>Not found</h1>"));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		server,
		submissions,
		away,
		count: (variant) =>
			submissions.filter((s) => s.variant === variant && s.host === "127.0.0.1")
				.length,
		close: () =>
			new Promise<void>((done) => {
				// A request left unanswered is settled, not cut off.
				for (const res of hanging.splice(0)) {
					res.writeHead(503);
					res.end();
				}
				server.closeAllConnections?.();
				server.close(() => done());
			}),
	};
}
