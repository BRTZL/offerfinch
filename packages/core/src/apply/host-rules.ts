import type { Board } from "./forms";
import type { HostRules, QueryValue, WidgetRule } from "./network-guard";

/**
 * What a real submission's session lets a board's other hosts receive, besides plain asset reads
 * (`BoardConfig.hosts`): the query parameters an asset or a widget frame may carry, and each
 * scoring widget's exact endpoints. From the live inspections (docs/form-inspection.md,
 * 2026-11-09). Enforced by `boardHostDecision` (network-guard.ts).
 */

/** Exactly one of the callback names the board's page was seen to pass ("onLoadReCaptcha"). */
const oneOf = (names: readonly string[]) =>
	new RegExp(`^(?:${names.map((n) => n.replace(/[$]/g, "\\$")).join("|")})$`);
/** A language code ("en", "en-GB"). */
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;
/** A widget's release id ("bSuJ2xBC8cFy7pM4Z3Hu9boH", 40 hex digits for hCaptcha). */
const RELEASE = /^[\w-]{8,40}$/;
const DIGITS = /^\d{1,6}$/;

/** Google Fonts' stylesheet: font names and axes, and how the font shows while loading. */
export const GOOGLE_FONTS: HostRules = {
	assets: [],
	query: {
		"fonts.googleapis.com": {
			family: /^[A-Za-z0-9 +]{1,60}(?::[A-Za-z,@;.\d]{1,60})?$/,
			display: /^(?:auto|block|swap|fallback|optional)$/,
		},
	},
};

/**
 * reCAPTCHA Enterprise from `host`, as Ashby and Greenhouse load it: the board's script (`render`
 * and the callback), its worker, and two frames (anchor, bframe) that carry the board's site key.
 * Only those frames may post, and only to `reload` and `clr`. Its page origin (`co`) must be the
 * form's own.
 */
export function recaptchaEnterprise(
	siteKeys: readonly string[],
	host = "www.recaptcha.net",
	callbacks: readonly string[] = ["onLoadReCaptcha"],
): HostRules {
	const params: Record<string, QueryValue> = {
		render: "site-key",
		onload: oneOf(callbacks),
		k: "site-key",
		hl: LANGUAGE,
		v: RELEASE,
		ar: /^\d$/,
		co: "form-origin",
		size: /^(?:invisible|normal|compact)$/,
		"anchor-ms": DIGITS,
		"execute-ms": DIGITS,
		ovv: /^[\w-]{1,16}$/,
		cb: /^[a-z0-9]{8,16}$/,
		bft: /^[\w-]{1,200}$/,
	};
	return {
		assets: [host],
		query: { [host]: params },
		widgets: [
			{
				name: "reCAPTCHA Enterprise",
				siteKeys,
				frames: [
					`${host}/recaptcha/enterprise/anchor`,
					`${host}/recaptcha/enterprise/bframe`,
				],
				endpoints: [
					`${host}/recaptcha/enterprise/reload`,
					`${host}/recaptcha/enterprise/clr`,
				],
			},
		],
	};
}

/**
 * hCaptcha, as Lever loads it: its script from `js.` (told the form's host), a frame from
 * `newassets.` whose site key sits in the fragment (never sent), and posts from that frame only to
 * `checksiteconfig`, `getcaptcha` and `checkcaptcha` on its API hosts.
 */
export function hcaptcha(
	siteKeys: readonly string[],
	hosts: { script: string; frame: string; api: readonly string[] } = {
		script: "js.hcaptcha.com",
		frame: "newassets.hcaptcha.com",
		api: ["hcaptcha.com", "api.hcaptcha.com", "api2.hcaptcha.com"],
	},
	callbacks: readonly string[] = ["onLoad", "_onLoad"],
): HostRules {
	return {
		assets: [hosts.script, hosts.frame],
		query: {
			[hosts.script]: {
				host: "form-host",
				se: RELEASE,
				onload: oneOf(callbacks),
				render: /^explicit$/,
				recaptchacompat: /^(?:on|off)$/,
				hl: LANGUAGE,
			},
		},
		widgets: [
			{
				name: "hCaptcha",
				siteKeys,
				keyInFragment: true,
				frames: [`${hosts.frame}/captcha/v1/`],
				endpoints: hosts.api.flatMap((api) => [
					`${api}/checksiteconfig`,
					`${api}/getcaptcha`,
					`${api}/checkcaptcha`,
				]),
			},
		],
	};
}

/**
 * Cloudflare Turnstile, as Workable and Personio load it: `api.js` from `host`, a frame under
 * `/cdn-cgi/challenge-platform/` whose path carries the site key, posting under the same path.
 * Neither board's site key is recorded yet, so no frame qualifies and every post is refused.
 */
export function turnstile(
	siteKeys: readonly string[],
	host = "challenges.cloudflare.com",
): HostRules {
	return {
		assets: [host],
		query: {
			// No callback name was recorded: a script told to call one is not loaded.
			[host]: {
				render: /^(?:explicit|auto)$/,
				lang: /^(?:auto|[a-z]{2}(?:-[a-z]{2})?)$/,
			},
		},
		widgets: [
			{
				name: "Turnstile",
				siteKeys,
				frames: [`${host}/cdn-cgi/challenge-platform/`],
				endpoints: [`${host}/cdn-cgi/challenge-platform/`],
			},
		],
	};
}

/**
 * Joins rule sets: hosts and widgets add up; a parameter two sets list for one host may meet
 * either's rule.
 */
export function joinRules(...parts: HostRules[]): HostRules {
	const query: Record<string, Record<string, QueryValue[]>> = {};
	for (const part of parts)
		for (const [host, params] of Object.entries(part.query ?? {})) {
			const into = query[host] ?? {};
			query[host] = into;
			for (const [key, rule] of Object.entries(params))
				into[key] = [...(into[key] ?? []), ...[rule].flat()];
		}
	const widgets: WidgetRule[] = parts.flatMap((p) => [...(p.widgets ?? [])]);
	return {
		assets: [...new Set(parts.flatMap((p) => [...p.assets]))],
		query,
		widgets,
		staticFetch: parts.flatMap((p) => [...(p.staticFetch ?? [])]),
	};
}

/**
 * Each board's widgets and query rules, with the site keys seen on its live posting (2026-11-09;
 * one posting per board, so a key is assumed board-wide until a second posting shows otherwise).
 * Recruitee's own hCaptcha and Workable's and Personio's Turnstile keys were not recorded: their
 * widgets get no posts until they are.
 */
export const BOARD_HOST_RULES: Record<Board, HostRules> = {
	ashby: {
		...joinRules(
			recaptchaEnterprise(["6LezdY0tAAAAAEnollNLCAI0z1VDGwM7AzGrU4XZ"]),
			GOOGLE_FONTS,
		),
		// The form's build manifest, keyed by the release's commit.
		staticFetch: [
			{
				host: "cdn.ashbyprd.com",
				path: /^\/frontend_non_user\/[0-9a-f]{40}\/\.vite\/manifest\.json$/,
			},
		],
	},
	greenhouse: {
		...recaptchaEnterprise(["6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0"]),
		// The form's translation files, one per namespace and content hash.
		staticFetch: [
			{
				host: "job-boards.cdn.greenhouse.io",
				path: /^\/locales\/[a-z]{2}(?:-[A-Z]{2})?\/[a-z_]{1,30}\.[\w-]{20,60}\.json$/,
			},
		],
	},
	lever: hcaptcha(["e33f87f8-88ec-4e1a-9a13-df9bbb1d8120"]),
	workable: turnstile([]),
	recruitee: { assets: [] },
	teamtailor: GOOGLE_FONTS,
	personio: turnstile([]),
};
