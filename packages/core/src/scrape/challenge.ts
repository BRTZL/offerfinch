/**
 * Detects blocks, bot challenges and CAPTCHAs. A hit stops the scrape and hands the source to
 * the user (`needs_human`). There is deliberately no retry, rotation or evasion path.
 */
const MARKERS: { pattern: RegExp; reason: string }[] = [
	{
		pattern: /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
		reason: "Cloudflare challenge page",
	},
	{
		pattern:
			/\/cdn-cgi\/challenge-platform\/|cf-chl-|cf_chl_opt|cf-browser-verification/i,
		reason: "Cloudflare challenge",
	},
	{
		pattern: /<title>\s*Attention Required!/i,
		reason: "Cloudflare block page",
	},
	// DataDome serves its challenge from captcha-delivery.com; the bare vendor name also shows up in cookie banners.
	{ pattern: /captcha-delivery\.com/i, reason: "DataDome challenge" },
	{
		pattern: /id="px-captcha"|px-captcha\.js|captcha\.px-cdn\.net/i,
		reason: "PerimeterX challenge",
	},
	{ pattern: /Pardon Our Interruption/i, reason: "Imperva challenge" },
	{
		pattern: /verify (?:that )?you are (?:a )?human|are you a robot\??/i,
		reason: "human verification prompt",
	},
	{
		pattern: /<title>\s*Access Denied\s*<\/title>/i,
		reason: "access denied page",
	},
];

const BLOCK_STATUSES = new Set([401, 403, 407, 429, 503]);

export function detectChallenge(
	status: number | null,
	html: string,
): string | null {
	if (status !== null && BLOCK_STATUSES.has(status)) return `HTTP ${status}`;
	for (const { pattern, reason } of MARKERS)
		if (pattern.test(html)) return reason;
	// A CAPTCHA widget on an otherwise empty page is a gate, not a form on a normal page.
	if (/g-recaptcha|h-captcha|hcaptcha\.com|turnstile/i.test(html)) {
		const text = html
			.replace(
				/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g,
				" ",
			)
			.replace(/\s+/g, " ");
		if (text.length < 600) return "CAPTCHA gate";
	}
	return null;
}
