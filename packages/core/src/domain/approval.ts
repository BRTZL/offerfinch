/**
 * Approval of one exact application (PLAN rule 1). An approval records the hash of every document
 * that would be submitted; entering `applying` requires an unrevoked approval whose hashes equal
 * the current documents' hashes. Both repositories call `compareApproval` inside the transition.
 */

/** Documents that leave the machine on submission. Notes stay private and are not part of approval. */
export const SUBMITTED_DOCUMENT_KINDS = [
	"cv",
	"cover_letter",
	"form_answers",
] as const;
export type SubmittedDocumentKind = (typeof SUBMITTED_DOCUMENT_KINDS)[number];

/**
 * Hex SHA-256 per submitted document, taken over the latest version's source text, and of the
 * posting they answer (`posting`: its title, employer and text). A review and an approval are of
 * these documents for this posting: when the posting changes, both are out of date.
 */
export type DocumentHashes = Partial<Record<SubmittedDocumentKind, string>> & {
	posting?: string;
};

/** What the documents were written for: the posting's title, employer and text. */
export interface PostingIdentity {
	title: string;
	company: string;
	description: string;
}

export function hashPosting(posting: PostingIdentity): Promise<string> {
	return sha256Hex(
		JSON.stringify([
			posting.title.trim(),
			posting.company.trim(),
			posting.description,
		]),
	);
}

/** SHA-256 through WebCrypto, available in Workers and Node. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function hashDocuments(
	documents: { kind: string; content: string }[],
	posting?: PostingIdentity,
): Promise<DocumentHashes> {
	const hashes: DocumentHashes = {};
	if (posting) hashes.posting = await hashPosting(posting);
	for (const doc of documents) {
		if ((SUBMITTED_DOCUMENT_KINDS as readonly string[]).includes(doc.kind))
			hashes[doc.kind as SubmittedDocumentKind] = await sha256Hex(doc.content);
	}
	return hashes;
}

export type ApprovalVerdict = { ok: true } | { ok: false; reason: string };

/** True only when an approval exists, covers a CV, and every hash equals the current one. */
export function compareApproval(
	approved: DocumentHashes | null,
	current: DocumentHashes,
): ApprovalVerdict {
	if (!approved) return { ok: false, reason: "no approval on record" };
	if (!current.cv) return { ok: false, reason: "no CV to submit" };
	for (const kind of SUBMITTED_DOCUMENT_KINDS) {
		if (approved[kind] !== current[kind])
			return {
				ok: false,
				reason: current[kind]
					? approved[kind]
						? `${kind} changed after approval`
						: `${kind} was added after approval`
					: `${kind} was removed after approval`,
			};
	}
	// Bound to the posting too. A record with no posting hash (made before postings were hashed)
	// can't show it was made against the current posting, so it never qualifies.
	if (approved.posting === undefined || current.posting === undefined)
		return {
			ok: false,
			reason: "the approval or review predates posting checks; check again",
		};
	if (approved.posting !== current.posting)
		return {
			ok: false,
			reason: "the posting (title, employer or text) changed after approval",
		};
	return { ok: true };
}

export class ApprovalRequiredError extends Error {
	constructor(
		readonly applicationId: string,
		readonly reason: string,
	) {
		super(
			`Refusing to apply: application ${applicationId} has no approval matching its documents (${reason})`,
		);
		this.name = "ApprovalRequiredError";
	}
}
