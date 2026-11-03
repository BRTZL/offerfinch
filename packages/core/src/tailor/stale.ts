import type { ProfileSnapshot } from "../profile/types";
import {
	CONFIRMED_PREFIX,
	checkQuote,
	normalizeForMatch,
} from "./profile-rules";

export interface StaleCitation {
	/** The claim, as checked. */
	claim: string;
	file: string;
	quote: string;
	reason: string;
}

/**
 * What a check cited, bound to its full text at check time: the whole record (an experience,
 * project, education or extra file, or About), the cited lines of skills.md, or the cited block
 * of answers.md (one answer). Any change to that text, the company or dates of a role included,
 * makes the review stale.
 */
export interface CitedUnit {
	file: string;
	quote: string;
	hash: string;
}

/** cyrb53: a fast 53-bit string hash, the same in Node, Workers and the browser. */
function hash53(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}:${text.length}`;
}

/** The text a citation stands on: its record, or for the shared files its lines or block. */
function unitText(
	profile: ProfileSnapshot,
	file: string,
	quote: string,
): string | null {
	const doc = profile.files.find((f) => f.path === file);
	if (!doc) return null;
	const needle = normalizeForMatch(quote);
	if (file === "skills.md") {
		const lines = doc.content
			.split("\n")
			.filter((l) => needle && normalizeForMatch(l).includes(needle));
		return lines.length > 0 ? lines.join("\n") : doc.content;
	}
	if (file === "answers.md") {
		const blocks = doc.content
			.split(/^(?=## )/m)
			.filter((b) => needle && normalizeForMatch(b).includes(needle));
		return blocks.length > 0 ? blocks.join("") : doc.content;
	}
	return doc.content;
}

/** Each citation of a check's supported claims, bound to its record's text now. */
export function citedUnits(
	claims: readonly unknown[],
	profile: ProfileSnapshot,
): CitedUnit[] {
	const out = new Map<string, CitedUnit>();
	for (const raw of claims) {
		const claim = (raw ?? {}) as StoredClaim;
		if (claim.supported !== true || !Array.isArray(claim.evidence)) continue;
		for (const cite of claim.evidence as {
			file?: unknown;
			quote?: unknown;
		}[]) {
			if (typeof cite?.file !== "string" || typeof cite.quote !== "string")
				continue;
			for (const piece of cite.quote.split(" … ").filter((p) => p.trim())) {
				const text = unitText(profile, cite.file, piece);
				if (text === null) continue;
				const unit = { file: cite.file, quote: piece, hash: hash53(text) };
				out.set(`${unit.file}\u0000${unit.hash}\u0000${unit.quote}`, unit);
			}
		}
	}
	return [...out.values()];
}

interface StoredClaim {
	text?: unknown;
	supported?: unknown;
	evidence?: unknown;
}

/**
 * Citations in a passed review that the profile no longer supports: the record a quote came
 * from was removed, or edited so the quote is no longer in it. A review is bound to its document
 * hashes; this binds it to the profile it cited too. Approval refuses while any is left, and the
 * check runs again on the current profile. Every quote is checked as the claims check checks it
 * (caution lines, Don't claim lists and questions are still not evidence).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Citation freshness checks keep invalidation conditions together to preserve approval boundaries.
export function staleCitations(
	claims: readonly unknown[],
	profile: ProfileSnapshot | null,
	flags: readonly { state: string; text: string | null }[] = [],
	cited: readonly CitedUnit[] = [],
): StaleCitation[] {
	const out: StaleCitation[] = [];
	// Any change to a cited record, not only to the quoted words: a bullet kept word for word under
	// a renamed company no longer says what was checked.
	for (const unit of cited) {
		const now = profile ? unitText(profile, unit.file, unit.quote) : null;
		if (now === null || hash53(now) !== unit.hash)
			out.push({
				claim: "",
				file: unit.file,
				quote: unit.quote,
				reason:
					now === null
						? "file not in profile"
						: "the cited record changed since the check",
			});
	}
	// A line the user confirmed in this review stands on their confirmation in answers.md: once
	// that answer is removed or edited, the line is unsupported again.
	const answers = (
		profile?.files.find((f) => f.path === "answers.md")?.content ?? ""
	).split("\n");
	for (const flag of flags) {
		if (flag.state !== "confirmed" || !flag.text) continue;
		const line = flag.text.replace(/\s+/g, " ").trim();
		const kept = answers.some(
			(a) =>
				a.startsWith(CONFIRMED_PREFIX.slice(0, -1)) && a.endsWith(`: ${line}`),
		);
		if (!kept)
			out.push({
				claim: flag.text,
				file: "answers.md",
				quote: line,
				reason: "the confirmation was removed or edited",
			});
	}
	for (const raw of claims) {
		const claim = (raw ?? {}) as StoredClaim;
		if (claim.supported !== true || !Array.isArray(claim.evidence)) continue;
		for (const cite of claim.evidence as {
			file?: unknown;
			quote?: unknown;
		}[]) {
			const file = typeof cite?.file === "string" ? cite.file : "";
			const quote = typeof cite?.quote === "string" ? cite.quote : "";
			// A quote kept from a caution line is its clean sentences joined with " … ".
			for (const piece of quote.split(" … ").filter((p) => p.trim())) {
				const check = profile
					? checkQuote(profile, file, piece)
					: { ok: false as const, reason: "no profile" };
				if (check.ok) continue;
				out.push({
					claim: typeof claim.text === "string" ? claim.text : "",
					file,
					quote,
					reason: check.reason,
				});
				break;
			}
		}
	}
	return out;
}
