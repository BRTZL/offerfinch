import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDocuments } from "@offerfinch/core/export/export";
import { FsBlobStore } from "@offerfinch/core/export/fs-blob";
import {
	ACCENTS,
	type Accent,
	DEFAULT_LOOK,
	type DocumentLook,
	FONTS,
	type Font,
	PAGE_SIZES,
	TEMPLATES,
} from "@offerfinch/core/export/look";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { tailorApplication } from "@offerfinch/core/tailor/tailor";
import { describe, expect, it } from "vitest";

import { localBrowser } from "./browser";

const PROFILE = join(import.meta.dirname, "../fixtures/tailor-profile");

describe("export in a real browser", () => {
	it("prints the CV and letter to PDF and DOCX, and the PDFs pass the ATS text check", async () => {
		const profile = await loadProfileFromDir(PROFILE);
		const job = {
			companyName: "Acme Robotics",
			title: "Senior Full-Stack Engineer",
			url: "https://jobs.example/1",
			locations: ["Remote"],
			workplaceType: "remote" as const,
			descriptionText:
				"Requirements\n- TypeScript, React and Next.js\n- PostgreSQL\n- Cloudflare Workflows and webhooks",
		};
		const docs = await tailorApplication(new FakeLlmProvider(), {
			job,
			profile,
			today: "2026-10-30",
		});
		const blobs = new FsBlobStore(await mkdtemp(join(tmpdir(), "export-")));
		const result = await exportDocuments(
			{ browser: localBrowser(), blobs },
			{
				userId: "u1",
				applicationId: "app1",
				jobTitle: job.title,
				companyName: job.companyName,
				postingText: job.descriptionText,
				profile,
				documents: [
					{ kind: "cv", version: 1, content: docs.cv },
					{ kind: "cover_letter", version: 1, content: docs.coverLetter },
				],
			},
		);
		expect(result.atsIssues).toEqual([]);
		expect(result.records.map((r) => r.storageKey)).toEqual([
			"users/u1/applications/app1/cv-v1-r2.pdf",
			"users/u1/applications/app1/cv-v1-r2.docx",
			"users/u1/applications/app1/cover_letter-v1-r2.pdf",
			"users/u1/applications/app1/cover_letter-v1-r2.docx",
		]);
		const pdf = await blobs.get("users/u1/applications/app1/cv-v1-r2.pdf");
		expect(new TextDecoder().decode(pdf?.slice(0, 5))).toBe("%PDF-");
		expect(result.records[0]?.meta).toMatchObject({
			pages: 1,
			browser: "local-playwright",
		});
	}, 60_000);
});

/** The page box Chrome printed, in points: A4 is 595 x 842, Letter 612 x 792. */
function mediaBox(pdf: Uint8Array): [number, number] {
	const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(
		new TextDecoder("latin1").decode(pdf),
	);
	if (!match) throw new Error("No MediaBox in the PDF");
	return [Math.round(Number(match[1])), Math.round(Number(match[2]))];
}

const POINTS = { A4: [595, 842], Letter: [612, 792] } as const;

describe("every look passes the ATS check in a real browser", () => {
	// Not a senior title: the CV's limit is one page, the strictest there is.
	const job = {
		companyName: "Acme Robotics",
		title: "Full-Stack Engineer",
		url: "https://jobs.example/1",
		locations: ["Remote"],
		workplaceType: "remote" as const,
		descriptionText:
			"Requirements\n- TypeScript, React and Next.js\n- PostgreSQL\n- Cloudflare Workflows and webhooks",
	};
	// Every template, font and page size together (accent changes colour only, so it rotates).
	const accents = Object.keys(ACCENTS) as Accent[];
	const looks: DocumentLook[] = TEMPLATES.flatMap((template) =>
		(Object.keys(FONTS) as Font[]).flatMap((font) =>
			PAGE_SIZES.map((pageSize, i) => ({
				template,
				font,
				pageSize,
				accent: accents[
					(TEMPLATES.indexOf(template) + i) % accents.length
				] as Accent,
			})),
		),
	);

	it.each(looks)(
		"$template, $font, $accent, $pageSize",
		async (look) => {
			const profile = await loadProfileFromDir(PROFILE);
			const docs = await tailorApplication(new FakeLlmProvider(), {
				job,
				profile,
				today: "2026-10-30",
			});
			const blobs = new FsBlobStore(await mkdtemp(join(tmpdir(), "export-")));
			const result = await exportDocuments(
				{ browser: localBrowser(), blobs },
				{
					userId: "u1",
					applicationId: "app1",
					jobTitle: job.title,
					companyName: job.companyName,
					postingText: job.descriptionText,
					profile,
					documents: [
						{ kind: "cv", version: 1, content: docs.cv },
						{ kind: "cover_letter", version: 1, content: docs.coverLetter },
					],
					look,
				},
			);
			expect(result.atsIssues).toEqual([]);
			const pdfs = result.records.filter((r) => r.format === "pdf");
			expect(pdfs.map((r) => r.meta.pages)).toEqual([1, 1]);
			for (const record of pdfs) {
				const pdf = await blobs.get(record.storageKey);
				if (!pdf) throw new Error(`${record.storageKey} was not stored`);
				expect(mediaBox(pdf)).toEqual(POINTS[look.pageSize]);
			}
		},
		60_000,
	);
});

describe("a long CV in every template and page size", () => {
	const job = {
		companyName: "Acme Robotics",
		title: "Full-Stack Engineer",
		url: "https://jobs.example/1",
		locations: ["Remote"],
		workplaceType: "remote" as const,
		descriptionText:
			"Requirements\n- TypeScript, React and Next.js\n- PostgreSQL",
	};
	const looks: DocumentLook[] = TEMPLATES.flatMap((template) =>
		PAGE_SIZES.map((pageSize) => ({ ...DEFAULT_LOOK, template, pageSize })),
	);

	it.each(looks)(
		"$template, $pageSize: past the one-page limit is flagged, and the text still extracts",
		async (look) => {
			const profile = await loadProfileFromDir(PROFILE);
			const docs = await tailorApplication(new FakeLlmProvider(), {
				job,
				profile,
				today: "2026-10-30",
			});
			// The draft's own bullets, many times over: real CV lines, well past one page.
			const bullets = docs.cv.split("\n").filter((l) => l.startsWith("- "));
			const long = `${docs.cv}\n\n## Selected work\n\n${Array.from({ length: 12 }, () => bullets.join("\n")).join("\n")}\n`;
			const blobs = new FsBlobStore(await mkdtemp(join(tmpdir(), "export-")));
			const result = await exportDocuments(
				{ browser: localBrowser(), blobs },
				{
					userId: "u1",
					applicationId: "app1",
					jobTitle: job.title,
					companyName: job.companyName,
					postingText: job.descriptionText,
					profile,
					documents: [{ kind: "cv", version: 1, content: long }],
					look,
				},
			);
			const pdf = result.records.find((r) => r.format === "pdf");
			expect(pdf?.meta.pages).toBeGreaterThan(1);
			expect(result.atsIssues.map((i) => i.message)).toEqual([
				`The PDF has ${pdf?.meta.pages} pages; the limit is 1.`,
			]);
		},
		60_000,
	);
});

describe("printing untrusted HTML", () => {
	it("sends no request anywhere, even for HTML that asks for remote resources", async () => {
		const { createServer } = await import("node:http");
		const { renderPdf } = await import("@offerfinch/core/export/export");
		const hits: string[] = [];
		const server = createServer((req, res) => {
			hits.push(req.url ?? "");
			res.end("x");
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const port = (server.address() as { port: number }).port;
		const base = `http://127.0.0.1:${port}`;
		try {
			const pdf = await renderPdf(
				localBrowser(),
				`<!doctype html><html><head><link rel="stylesheet" href="${base}/css"><style>body{background:url(${base}/bg)}</style></head><body><img src="${base}/img"><script>fetch("${base}/js")</script><iframe src="${base}/frame"></iframe><p>Hi</p></body></html>`,
			);
			expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
			expect(hits).toEqual([]);
		} finally {
			server.close();
		}
	}, 60_000);
});
