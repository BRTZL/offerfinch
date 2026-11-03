import type { NormalizedJob } from "../domain/types";
import { normalizeUrl } from "../domain/url";
import type { LlmProvider } from "../scoring/llm";
import {
	type JobSource,
	RobotsDisallowedError,
	SourceBlockedError,
	type SourceTarget,
	USER_AGENT,
} from "../sources/types";
import type { BrowserPage, BrowserProvider } from "./browser";
import { detectChallenge } from "./challenge";
import { extractJobsWithLlm } from "./llm-extract";
import { jsonLdJobPostings, parseListing, type ScrapedJob } from "./parsers";
import { HostRateLimiter } from "./rate-limit";
import { RobotsCache } from "./robots";

export interface ScrapeSourceOptions {
	browser: BrowserProvider;
	/**
	 * LLM fallback when no parser finds jobs, for a run with no user (the CLI's smoke check). A
	 * scan passes its user's metered model in the target instead, which takes precedence.
	 */
	llm?: LlmProvider;
	robots?: RobotsCache;
	rateLimiter?: HostRateLimiter;
	/** Detail pages fetched per listing to fill in descriptions. */
	maxDetailPages?: number;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Careers pages without an API, loaded through a real browser. Honest user agent, robots.txt
 * checked for every URL, a minimum gap between requests per host, and any block or challenge
 * stops the run with `SourceBlockedError`.
 */
export class ScrapeSource implements JobSource {
	readonly kind = "scrape" as const;
	private readonly robots: RobotsCache;
	private readonly rateLimiter: HostRateLimiter;

	constructor(private readonly options: ScrapeSourceOptions) {
		this.robots = options.robots ?? new RobotsCache(USER_AGENT);
		this.rateLimiter = options.rateLimiter ?? new HostRateLimiter(5_000);
	}

	/** robots.txt and the per-host gap, for every URL the browser is about to fetch. */
	private async allow(url: string): Promise<void> {
		const policy = await this.robots.policyFor(url);
		if (!policy.isAllowed(url)) throw new RobotsDisallowedError(url);
		await this.rateLimiter.wait(url, policy.crawlDelaySeconds);
	}

	private async load(page: BrowserPage, url: string): Promise<string> {
		await this.allow(url);
		const { status, url: finalUrl } = await page.goto(url, {
			waitUntil: "load",
			// Each redirect destination passes the same checks before it is fetched.
			beforeRedirect: (next) => this.allow(next),
		});
		// Backstop for a browser that cannot report hops: never use a page robots.txt disallows.
		if (
			finalUrl &&
			finalUrl !== url &&
			!(await this.robots.policyFor(finalUrl)).isAllowed(finalUrl)
		)
			throw new RobotsDisallowedError(finalUrl);
		const html = await page.content();
		const blocked = detectChallenge(status, html);
		if (blocked) throw new SourceBlockedError(url, blocked);
		if (status !== null && status >= 400)
			throw new Error(`HTTP ${status} from ${url}`);
		return html;
	}

	async listJobs(target: SourceTarget): Promise<NormalizedJob[]> {
		const listingUrl = target.sourceKey;
		const session = await this.options.browser.openSession();
		try {
			const page = await session.newPage();
			const html = await this.load(page, listingUrl);
			let jobs = parseListing(html, page.url() || listingUrl, target.parser);
			const llm = target.llm ?? this.options.llm;
			if (jobs.length === 0 && llm) {
				this.options.log?.("no parser matched, using LLM extraction", {
					url: listingUrl,
				});
				jobs = await extractJobsWithLlm(llm, html, listingUrl);
			}
			const maxDetails = this.options.maxDetailPages ?? 20;
			let detailsFetched = 0;
			const enriched: ScrapedJob[] = [];
			for (const job of jobs) {
				if (
					!job.descriptionText &&
					detailsFetched < maxDetails &&
					job.url !== listingUrl
				) {
					detailsFetched += 1;
					try {
						const detailHtml = await this.load(page, job.url);
						const posting = jsonLdJobPostings(detailHtml, job.url)[0];
						enriched.push({
							...job,
							...posting,
							url: job.url,
							title: posting?.title || job.title,
						});
						continue;
					} catch (error) {
						if (
							error instanceof SourceBlockedError ||
							error instanceof RobotsDisallowedError
						)
							throw error;
						this.options.log?.("detail page failed", {
							url: job.url,
							error: String(error),
						});
					}
				}
				enriched.push(job);
			}
			return enriched.map((job) => toNormalized(job, listingUrl));
		} finally {
			await session.close();
		}
	}
}

/**
 * Stable id for a scraped job. A site's own identifier (JSON-LD `identifier`) is only unique on
 * that site, and jobs dedupe on (user, source, external id), so it is namespaced by the company's
 * careers page; otherwise "1" on one site would swallow job "1" on another. Without an
 * identifier the normalized job URL is already global.
 */
function scrapedExternalId(job: ScrapedJob, listingUrl: string): string {
	return job.externalId
		? `${normalizeUrl(listingUrl)}#${job.externalId}`
		: normalizeUrl(job.url);
}

function toNormalized(job: ScrapedJob, listingUrl: string): NormalizedJob {
	const locations = job.locations ?? [];
	const text = `${locations.join(" ")} ${job.title}`;
	return {
		source: "scrape",
		externalId: scrapedExternalId(job, listingUrl),
		url: job.url,
		title: job.title,
		locations,
		workplaceType:
			job.workplaceType ??
			(/\bremote\b/i.test(text)
				? "remote"
				: /\bhybrid\b/i.test(text)
					? "hybrid"
					: "unknown"),
		employmentType: job.employmentType,
		descriptionText: job.descriptionText ?? "",
		publishedAt: job.publishedAt,
	};
}
