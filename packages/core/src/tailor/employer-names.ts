import type { ProfileSnapshot } from "../profile/types";
import {
	type ExperienceRecord,
	evidenceProfile,
	nameKey,
} from "./profile-rules";

/** The names that stand for each employer, for telling which one a line is about. */
const COMMON_CAPS = new Set(
	`AND ARE FOR FROM INTO NOT NULL SELECT UPDATE INSERT DELETE WHERE JOIN SKIP LOCKED LIMIT ORDER
	GROUP CREATE TABLE INDEX API APIS SQL JSON HTTP HTTPS HTML CSS URL URLS REST CLI SDK SDKS UI UX
	AWS GCP CDN DNS JWT ORM SSR SSG SPA PWA LLM LLMS RAG MCP ERP CRM CMS SEO SLA ATS DLQ TTL CPU GPU
	RAM SSD USB PDF CSV XML YAML TODO TBD FAQ CEO CTO VP HR QA QE CI CD`.split(
		/\s+/,
	),
);

/**
 * Names that stand for an experience record (an employer): its company, compared case-insensitively; the capitalized
 * names in the product its file names ("**Team / product:** DirectorAI, …"); and CamelCase or
 * all-caps names (three letters or more, not a common acronym) found in its file and no other
 * evidence file. Those are compared exactly, so "FOR UPDATE" in a file never makes "for" a name.
 * A line naming one of them is about that employer.
 */
function aliases(
	profile: ProfileSnapshot,
	record: ExperienceRecord,
): { loose: string[]; exact: string[] } {
	const evidence = evidenceProfile(profile).files;
	const own = evidence.find((f) => f.path === record.file)?.content ?? "";
	const others = evidence
		.filter((f) => f.path !== record.file)
		.map((f) => f.content)
		.join("\n");
	// The product's own names ("DirectorAI", "Argos"), not the words of its description.
	const company = new Set(record.company.split(/\s+/));
	const product = (
		own
			.match(/^-\s+\*\*(?:Team \/ product|Products?|Team):\*\*\s+(.+)$/im)?.[1]
			?.split(/[,(]/)[0]
			?.match(/\b\p{Lu}[\p{L}\d]+\b/gu) ?? []
	).filter((n) => !company.has(n) && !COMMON_CAPS.has(n));
	const exact = [
		...(own.match(
			/\b\p{Lu}[\p{Ll}\d]+\p{Lu}[\p{L}\d]*\b|\b\p{Lu}{3,}\d*\b/gu,
		) ?? []),
	].filter(
		(n, i, all) =>
			all.indexOf(n) === i &&
			!COMMON_CAPS.has(n) &&
			!new RegExp(`(?<![\\p{L}\\d])${n}(?![\\p{L}\\d])`, "u").test(others),
	);
	return {
		loose: [record.company],
		exact: [...new Set([...product, ...exact])],
	};
}

/** Whether a text names one of these: loose names as whole words, exact names as written. */
export function mentions(
	text: string,
	names: { loose: string[]; exact: string[] },
): boolean {
	const key = ` ${nameKey(text)} `;
	return (
		names.loose.some((n) => {
			const k = nameKey(n);
			return (
				k.length > 0 && (key.includes(` ${k} `) || key.includes(` ${k}'s `))
			);
		}) ||
		names.exact.some((n) =>
			new RegExp(`(?<![\\p{L}\\d])${n}(?![\\p{L}\\d])`, "u").test(text),
		)
	);
}

/** The names that stand for an employer (its company, products and own CamelCase names). */
export function roleAliases(
	profile: ProfileSnapshot,
	record: ExperienceRecord,
): { loose: string[]; exact: string[] } {
	return aliases(profile, record);
}
