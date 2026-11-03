import type { LlmProvider } from "../scoring/llm";
import type { BrowserProvider } from "./browser";
import { type ExtractedPosting, readPostingPage } from "./llm-extract";
import {
	type DestinationPolicy,
	fetchOnce,
	fetchPublic,
	responseText,
} from "./public-fetch";

/**
 * A page a user linked, from anywhere on the internet, read without reaching this Mac or a
 * private network:
 * 1. its HTML, fetched by Node with every hop checked and pinned, and no JavaScript run. The
 *    page's structured data or main content is the posting;
 * 2. only when that HTML holds no posting, the page rendered with JavaScript in a browser that
 *    has no network of its own: every request it makes goes through the same checking fetcher;
 * 3. only when neither names the posting (or its company), the model, which picks lines and
 *    fields and writes nothing.
 * Throws when a destination is refused or the page can't be fetched.
 */
export async function readLinkedPage(
	url: string,
	deps: {
		policy: DestinationPolicy;
		browser?: BrowserProvider | null;
		llm: LlmProvider | null;
		userAgent?: string;
	},
): Promise<{ posting: ExtractedPosting } | { needs: string }> {
	const headers = {
		accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
		"accept-language": "en-US,en;q=0.8",
		...(deps.userAgent ? { "user-agent": deps.userAgent } : {}),
	};
	const page = await fetchPublic(url, deps.policy, { headers });
	if (page.status >= 400) return { needs: `The page answered ${page.status}` };
	const type = page.headers["content-type"] ?? "text/html";
	if (!/html|xml|text\/plain/i.test(type))
		return { needs: "That link is not a web page" };
	let html = responseText(page);
	let posting = await readPostingPage(html, page.url, null);

	if (!posting && deps.browser?.isolates) {
		const rendered = await renderPinned(page.url, deps.browser, deps.policy, {
			...headers,
		}).catch(() => null);
		if (rendered) {
			html = rendered;
			posting = await readPostingPage(html, page.url, null);
		}
	}
	if (!posting?.company && deps.llm)
		posting = (await readPostingPage(html, page.url, deps.llm)) ?? posting;
	return posting
		? { posting }
		: { needs: "That page doesn't look like a single job posting" };
}

/** The page after its scripts ran, in a session whose every request is checked and pinned. */
async function renderPinned(
	url: string,
	browser: BrowserProvider,
	policy: DestinationPolicy,
	headers: Record<string, string>,
): Promise<string> {
	const session = await browser.openSession({
		network: "pinned",
		fetcher: (request) =>
			fetchOnce(request.url, policy, {
				method: request.method,
				headers: { ...request.headers, ...headers },
				timeoutMs: 15_000,
			}),
	});
	try {
		const page = await session.newPage();
		await page.goto(url, { timeoutMs: 30_000, waitUntil: "domcontentloaded" });
		await page.waitForNetworkIdle(5_000);
		return await page.content();
	} finally {
		await session.close().catch(() => {});
	}
}
