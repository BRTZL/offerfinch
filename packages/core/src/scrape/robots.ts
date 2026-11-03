import type { FetchLike } from "../sources/types";

interface Group {
	agents: string[];
	rules: { allow: boolean; path: string }[];
	crawlDelay?: number;
}

export interface RobotsPolicy {
	isAllowed(url: string): boolean;
	crawlDelaySeconds?: number;
}

function parseGroups(text: string): Group[] {
	const groups: Group[] = [];
	let current: Group | null = null;
	let lastWasAgent = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
		if (!match) continue;
		const field = match[1]?.toLowerCase();
		const value = match[2]?.trim() ?? "";
		if (field === "user-agent") {
			if (!current || !lastWasAgent) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (!current) continue;
		if (field === "allow" || field === "disallow") {
			if (value === "" && field === "disallow") continue;
			current.rules.push({ allow: field === "allow", path: value });
		} else if (field === "crawl-delay") {
			const delay = Number(value);
			if (Number.isFinite(delay)) current.crawlDelay = delay;
		}
	}
	return groups;
}

function ruleMatches(rulePath: string, path: string): boolean {
	const anchored = rulePath.endsWith("$");
	const pattern = (anchored ? rulePath.slice(0, -1) : rulePath)
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

/** RFC 9309 robots.txt evaluation: the most specific group for our agent, longest matching rule wins. */
export function parseRobots(text: string, userAgent: string): RobotsPolicy {
	const token = userAgent.split("/")[0]?.toLowerCase() ?? "*";
	const groups = parseGroups(text);
	const specific = groups.filter((g) =>
		g.agents.some((a) => a !== "*" && token.includes(a)),
	);
	const chosen =
		specific.length > 0
			? specific
			: groups.filter((g) => g.agents.includes("*"));
	const rules = chosen.flatMap((g) => g.rules);
	const crawlDelay = chosen
		.map((g) => g.crawlDelay)
		.find((d) => d !== undefined);
	return {
		crawlDelaySeconds: crawlDelay,
		isAllowed(url: string) {
			const parsed = new URL(url);
			const path = `${parsed.pathname}${parsed.search}`;
			let best: { allow: boolean; length: number } | null = null;
			for (const rule of rules) {
				if (!ruleMatches(rule.path, path)) continue;
				const length = rule.path.length;
				if (
					!best ||
					length > best.length ||
					(length === best.length && rule.allow)
				)
					best = { allow: rule.allow, length };
			}
			return best ? best.allow : true;
		},
	};
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };
const DISALLOW_ALL: RobotsPolicy = { isAllowed: () => false };

/** Fetches and caches robots.txt per origin. Unreachable (5xx/network) means disallow, per RFC 9309. */
export class RobotsCache {
	private readonly cache = new Map<string, Promise<RobotsPolicy>>();

	constructor(
		private readonly userAgent: string,
		private readonly fetchImpl: FetchLike = fetch,
	) {}

	policyFor(url: string): Promise<RobotsPolicy> {
		const origin = new URL(url).origin;
		let policy = this.cache.get(origin);
		if (!policy) {
			policy = this.load(origin);
			this.cache.set(origin, policy);
		}
		return policy;
	}

	async isAllowed(url: string): Promise<boolean> {
		return (await this.policyFor(url)).isAllowed(url);
	}

	private async load(origin: string): Promise<RobotsPolicy> {
		try {
			const response = await this.fetchImpl(`${origin}/robots.txt`, {
				headers: { "user-agent": this.userAgent },
			});
			if (response.status >= 500) return DISALLOW_ALL;
			if (!response.ok) return ALLOW_ALL;
			return parseRobots(await response.text(), this.userAgent);
		} catch {
			return DISALLOW_ALL;
		}
	}
}
