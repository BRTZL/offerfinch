import type { BrowserPage } from "../scrape/browser";
import { declineBoardCookies, openForm } from "./applier";
import {
	type FormRead,
	type FormReadRefusal,
	type FormSchema,
	schemaKey,
} from "./form-schema";
import {
	BOARD_CONFIGS,
	companyKeyProblem,
	type FormBoard,
	type FormField,
	optionsScript,
	scanScript,
} from "./forms";
import { boardClosedReason } from "./open-boards";
import {
	type ApplyDeps,
	allowedHostsFor,
	formUrlOf,
	hostAllowed,
	modeOf,
	type SubmissionContext,
} from "./submit";
import { readWebFormOnPage } from "./web-form";
import { webReadHosts } from "./web-hosts";
import type { WebFormModel } from "./web-model";

/**
 * The form reader (docs/auto-apply-plan.md, step 2): before review, the application's hosted form
 * is opened read-only and scanned, so the review can show every field and the value it will get.
 * The page loads with only GET, HEAD and GraphQL queries allowed; once the form is scanned the
 * network closes completely, and only then are comboboxes opened to read their options. Nothing
 * is typed, chosen, uploaded or clicked that could send anything.
 */

async function tryEvaluate<T>(
	page: BrowserPage,
	script: string,
): Promise<T | null> {
	try {
		return await page.evaluate<T>(script);
	} catch {
		return null;
	}
}

/**
 * Reads the form on a page whose session is read-only. Closes the network after the scan, before
 * the first click. A challenge, a block or a missing form comes back as a failure with its reason.
 */
export async function readFormOnPage(
	page: BrowserPage,
	board: FormBoard,
	url: string,
	model?: WebFormModel | null,
): Promise<{ ok: true; schema: FormSchema } | FormReadRefusal> {
	// An employer's own form: the generic scan (web-form.ts).
	if (board === "web") return readWebFormOnPage(page, url, model);
	const config = BOARD_CONFIGS[board];
	const stop = await openForm(page, url, config);
	if (stop) return { ok: false, reason: stop.message };
	const fields = await tryEvaluate<FormField[] | null>(
		page,
		scanScript(config),
	);
	if (!fields)
		return {
			ok: false,
			reason: `No ${board} application form at ${page.url()}.`,
		};
	const submit = await tryEvaluate<string | null>(
		page,
		`(() => { const b = document.querySelector(${JSON.stringify(config.submit)}); return b ? (b.textContent || "").replace(/\\s+/g, " ").trim() : null; })()`,
	);
	// Nothing leaves the browser from here on, GETs included: opening a combobox may run the
	// page's own scripts.
	page.restrictNetwork("none");
	// A board's own cookie dialog would take the clicks that open the comboboxes (Workable).
	await declineBoardCookies(page, config);
	for (const field of fields) {
		if (field.kind !== "combobox" || field.options.length > 0) continue;
		const at = `[data-jp="${field.ref}"]`;
		await page.click(at).catch(() => {});
		await page.waitForTimeout(300);
		field.options =
			(await tryEvaluate<string[]>(page, optionsScript(field.ref)))?.slice(
				0,
				50,
			) ?? [];
		await page.press(at, "Escape").catch(() => {});
	}
	return {
		ok: true,
		schema: {
			board,
			url,
			submit,
			fields: fields.map((f) => ({
				...f,
				key: schemaKey(f),
				page: 1,
				section: f.section ?? "",
			})),
		},
	};
}

/**
 * Reads one application's form before review, or says why not. Never throws: a failure is
 * recorded and review goes ahead without the field list. Gated before any browser opens: only
 * an "auto" board, and only a host a submission of this job may use (`allowedHostsFor`: the local
 * fixture boards, and the board's own form host once the user opened it in Settings › Applying),
 * so a form is never read where it could not be submitted.
 */
export async function readApplicationForm(
	apply: ApplyDeps,
	context: SubmissionContext,
	now: Date = new Date(),
	/** An employer's own form: the drafting model labels what the page names nothing for. */
	model?: WebFormModel | null,
): Promise<FormRead> {
	const readAt = now.toISOString();
	const board = context.board;
	const mode = modeOf(context);
	if (mode.mode === "handoff" || !board)
		return {
			status: "skipped",
			board: board ?? "",
			url: context.jobUrl,
			note: mode.reason || "This board has no automatic form filling.",
			readAt,
		};
	// A company key that is not one DNS label would make the form's host another site.
	const badKey =
		board === "web" ? null : companyKeyProblem(board, context.companyKey);
	if (badKey)
		return {
			status: "skipped",
			board,
			url: context.jobUrl,
			note: `The form was not read before review: ${badKey}`,
			readAt,
		};
	const url = formUrlOf(context, board, apply.boardBases);
	// The same hosts a submission of this job may open: none on a board the user has not opened.
	const allowed = allowedHostsFor(apply, context, url);
	if (!hostAllowed(url, allowed))
		return {
			status: "skipped",
			board,
			url,
			note:
				context.boardOpened === false
					? `The form was not read before review: ${boardClosedReason(board)} Nothing will be filled there until it is opened.`
					: `The form was not read before review: automatic submission to ${new URL(url).hostname} is not turned on, so nothing will be filled there.`,
			readAt,
		};
	try {
		const result = apply.readForm
			? await apply.readForm({ board, url })
			: await readInSession(apply, board, url, allowed, model);
		if (result.ok) return { status: "read", schema: result.schema, readAt };
		return {
			status: "failed",
			board,
			url,
			note: result.handoff
				? `${result.reason} The form was read before review, and it is one to fill in on the employer's site.`
				: `The form could not be read before review: ${result.reason}`,
			readAt,
		};
	} catch (error) {
		return {
			status: "failed",
			board,
			url,
			note: `The form could not be read before review: ${error instanceof Error ? error.message : String(error)}`,
			readAt,
		};
	}
}

async function readInSession(
	apply: ApplyDeps,
	board: FormBoard,
	url: string,
	allowed: string[],
	model: WebFormModel | null | undefined,
): ReturnType<typeof readFormOnPage> {
	// The page stays on the hosts submission may use, redirects included (an employer's form:
	// its own site, web-hosts.ts; submission then gets only the hosts the read saw it send to).
	const session = await apply.browser.openSession({
		network: "read_only",
		allowedHosts: board === "web" ? webReadHosts(url) : allowed,
		// A real read never reaches this Mac or a private network; only a fixture read may.
		refusePrivateNetwork: !apply.fixtures,
	});
	try {
		const page = await session.newPage();
		const result = await readFormOnPage(page, board, url, model);
		// Unload handlers (beacons) run now, while the page still aborts every request.
		await page.goto("about:blank").catch(() => {});
		return result;
	} finally {
		await session.close().catch(() => {});
	}
}
