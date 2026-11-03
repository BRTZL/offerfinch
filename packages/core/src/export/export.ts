import type { ExportRecord } from "../pipeline/ports";
import type { ProfileSnapshot } from "../profile/types";
import { SKILL_TERMS } from "../scoring/fake";
import { type BrowserProvider, UNTRUSTED_CONTENT } from "../scrape/browser";
import {
	evidenceProfile,
	experienceRecords,
	type RuleIssue,
} from "../tailor/profile-rules";
import { parseContact } from "../tailor/tailor";
import { atsIssues, documentKeywords, pdfText } from "./ats";
import { markdownToDocx, markdownToHtml } from "./render";

/** Storage for exported files: a local directory in the desktop app, memory in tests. */
export interface BlobStore {
	readonly name: string;
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	/** Deletes every object whose key starts with `prefix` (a user's files); returns how many. */
	deletePrefix(prefix: string): Promise<number>;
}

export class MemoryBlobStore implements BlobStore {
	readonly name = "memory";
	readonly objects = new Map<
		string,
		{ bytes: Uint8Array; contentType: string }
	>();
	async put(key: string, bytes: Uint8Array, contentType: string) {
		this.objects.set(key, { bytes, contentType });
	}
	async get(key: string) {
		return this.objects.get(key)?.bytes ?? null;
	}
	async deletePrefix(prefix: string) {
		let n = 0;
		for (const key of [...this.objects.keys()])
			if (key.startsWith(prefix)) {
				this.objects.delete(key);
				n++;
			}
		return n;
	}
}

export const CONTENT_TYPES = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

/** Prints HTML built from model-written Markdown: scripts off, no network (see `UNTRUSTED_CONTENT`). */
export async function renderPdf(
	browser: BrowserProvider,
	html: string,
): Promise<Uint8Array> {
	const session = await browser.openSession(UNTRUSTED_CONTENT);
	try {
		const page = await session.newPage();
		await page.setContent(html);
		return await page.pdf();
	} finally {
		await session.close();
	}
}

/** One page for a letter; two for a senior CV, otherwise one, as the skill says. */
export function pageLimit(
	kind: "cv" | "cover_letter",
	jobTitle: string,
): number {
	if (kind === "cover_letter") return 1;
	return /\b(senior|staff|lead|principal|sr\.?)\b/i.test(jobTitle) ? 2 : 1;
}

export interface ExportInput {
	userId: string;
	applicationId: string;
	jobTitle: string;
	companyName: string;
	postingText: string;
	profile: ProfileSnapshot;
	documents: {
		kind: "cv" | "cover_letter";
		version: number;
		content: string;
	}[];
}

export interface ExportResult {
	records: ExportRecord[];
	atsIssues: RuleIssue[];
}

/**
 * Exports the CV and letter to PDF (through the browser provider) and DOCX, stores both, and
 * runs the ATS text check on each PDF. Keys carry the source version, so a re-export after an
 * edit never overwrites the file an approval was based on.
 */
export async function exportDocuments(
	deps: { browser: BrowserProvider; blobs: BlobStore },
	input: ExportInput,
): Promise<ExportResult> {
	const profile = evidenceProfile(input.profile);
	const contact = parseContact(profile);
	const records = experienceRecords(profile);
	const result: ExportResult = { records: [], atsIssues: [] };
	for (const doc of input.documents) {
		const base = `users/${input.userId}/applications/${input.applicationId}/${doc.kind}-v${doc.version}`;
		const title = `${contact.name} ${doc.kind === "cv" ? "CV" : "Cover letter"} ${input.companyName}`;
		const pdf = await renderPdf(
			deps.browser,
			markdownToHtml(doc.content, title),
		);
		const extracted = await pdfText(pdf);
		const issues = atsIssues(extracted, {
			kind: doc.kind,
			markdown: doc.content,
			contact,
			records,
			keywords: documentKeywords(doc.content, input.postingText, SKILL_TERMS),
			maxPages: pageLimit(doc.kind, input.jobTitle),
		});
		const docx = await markdownToDocx(doc.content);
		await deps.blobs.put(`${base}.pdf`, pdf, CONTENT_TYPES.pdf);
		await deps.blobs.put(`${base}.docx`, docx, CONTENT_TYPES.docx);
		const meta = {
			pages: extracted.pages,
			bytes: pdf.byteLength,
			atsIssues: issues,
			browser: deps.browser.name,
			store: deps.blobs.name,
		};
		result.records.push(
			{
				kind: doc.kind,
				format: "pdf",
				sourceVersion: doc.version,
				storageKey: `${base}.pdf`,
				meta,
			},
			{
				kind: doc.kind,
				format: "docx",
				sourceVersion: doc.version,
				storageKey: `${base}.docx`,
				meta: { bytes: docx.byteLength, store: deps.blobs.name },
			},
		);
		result.atsIssues.push(...issues);
	}
	return result;
}
