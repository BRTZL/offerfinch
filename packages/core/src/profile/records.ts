import { z } from "zod";

import type { StructuredProfile } from "./structure";
import type { ProfileDocument } from "./types";

/**
 * The profile as structured records (PLAN C). The user edits records; tailoring, fit scoring and
 * the claims check read them through `renderRecords`, which writes each record to a file keyed by
 * its id in the Markdown layout those steps already read. A citation's file therefore names one
 * record (`experience/<id>.md`), or one section (`personal.md`, `skills.md`), and an edit never
 * moves a record to another path.
 */

const RECORD_KINDS = [
	"about",
	"experience",
	"project",
	"skill",
	"education",
	"extra",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const line = z.string().trim().max(300);
const block = (max: number) => z.string().max(max);

const aboutData = z.object({
	name: line.default(""),
	email: line.default(""),
	phone: line.default(""),
	location: line.default(""),
	linkedin: line.default(""),
	website: line.default(""),
	github: line.default(""),
	summary: block(20_000).default(""),
	/** Anything else about the person, as Markdown (work authorization, notice period…). */
	more: block(20_000).default(""),
});

const experienceData = z.object({
	company: line.min(1, "Company is required"),
	title: line.default(""),
	location: line.default(""),
	start: line.default(""),
	end: line.default(""),
	bullets: z.array(block(1_000)).max(60).default([]),
	more: block(20_000).default(""),
});

const projectData = z.object({
	name: line.min(1, "Name is required"),
	description: block(5_000).default(""),
	bullets: z.array(block(1_000)).max(40).default([]),
});

const skillData = z.object({ name: line.min(1, "Skill is required") });

const educationData = z.object({
	school: line.default(""),
	field: line.default(""),
	years: line.default(""),
	note: block(1_000).default(""),
});

const extraData = z.object({
	title: line.min(1, "Title is required"),
	text: block(20_000).default(""),
});

export const recordInputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("about"), data: aboutData }),
	z.object({ kind: z.literal("experience"), data: experienceData }),
	z.object({ kind: z.literal("project"), data: projectData }),
	z.object({ kind: z.literal("skill"), data: skillData }),
	z.object({ kind: z.literal("education"), data: educationData }),
	z.object({ kind: z.literal("extra"), data: extraData }),
]);

export type RecordInput = z.infer<typeof recordInputSchema>;
type AboutData = z.infer<typeof aboutData>;
export type ExperienceData = z.infer<typeof experienceData>;

/** A saved record: its fields, where it came from and when. */
export type ProfileRecord = RecordInput & {
	id: string;
	position: number;
	source: string;
	sourceDate: Date;
};

/** A record before it is saved: from a resume import or a profile import. */
export type DraftRecord = RecordInput & { source: string };

/* ------------------------------------------------------------------ render */

/** One line of Markdown: no line breaks, no leading heading or list marker. */
function oneLine(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/^(?:[#>*\-\s]|\+(?!\d))+/, "")
		.trim();
}

/** A list item's text: one line, its own list or heading marker removed, bold kept. */
function listItem(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/^(?:[-*+][ \t]+|#+[ \t]*|>[ \t]*)+/, "")
		.trim();
}

const bulletList = (items: string[]) =>
	items
		.map(listItem)
		.filter(Boolean)
		.map((b) => `- ${b}`)
		.join("\n");

const joinBlocks = (...blocks: (string | null | undefined)[]) =>
	`${blocks
		.map((b) => b?.trim())
		.filter(Boolean)
		.join("\n\n")}\n`;

const ABOUT_PATH = "personal.md";
const SUMMARY_PATH = "summary.md";
const SKILLS_PATH = "skills.md";

/** The file a record renders to. The About record renders to personal.md and summary.md. */
export function recordPath(record: { id: string; kind: RecordKind }): string {
	switch (record.kind) {
		case "about":
			return ABOUT_PATH;
		case "skill":
			return SKILLS_PATH;
		case "experience":
			return `experience/${record.id}.md`;
		case "project":
			return `projects/${record.id}.md`;
		case "education":
			return `education/${record.id}.md`;
		case "extra":
			return `extras/${record.id}.md`;
	}
}

function aboutFiles(data: AboutData): ProfileDocument[] {
	const field = (label: string, value: string) =>
		oneLine(value) ? `- **${label}:** ${oneLine(value)}` : null;
	const fields = [
		field("Name", data.name),
		field("Email", data.email),
		field("Phone", data.phone),
		field("LinkedIn", data.linkedin),
		field("Website", data.website),
		field("GitHub", data.github),
		field("Location", data.location),
	]
		.filter(Boolean)
		.join("\n");
	const files = [
		{ path: ABOUT_PATH, content: joinBlocks("# Personal", fields, data.more) },
	];
	if (data.summary.trim())
		files.push({
			path: SUMMARY_PATH,
			content: joinBlocks("# Summary", data.summary),
		});
	return files;
}

function experienceFile(id: string, d: ExperienceData): ProfileDocument {
	const dates =
		d.start || d.end
			? `- **Dates:** ${oneLine(d.start)} – ${oneLine(d.end) || "Present"}`
			: null;
	const location = oneLine(d.location)
		? `- **Location:** ${oneLine(d.location)}`
		: null;
	const header = [dates, location].filter(Boolean).join("\n");
	const bullets = bulletList(d.bullets);
	return {
		path: `experience/${id}.md`,
		content: joinBlocks(
			`# ${oneLine(d.company)} — ${oneLine(d.title)}`,
			header,
			bullets ? `## What I did\n\n${bullets}` : null,
			d.more,
		),
	};
}

/**
 * The records as the profile files the pipeline reads, in a stable order: About, skills, then
 * each kind by position. Pure: the same records always give the same files.
 */
export function renderRecords(
	records: readonly ProfileRecord[],
): ProfileDocument[] {
	const sorted = [...records].sort(
		(a, b) =>
			RECORD_KINDS.indexOf(a.kind) - RECORD_KINDS.indexOf(b.kind) ||
			a.position - b.position ||
			a.id.localeCompare(b.id),
	);
	const files: ProfileDocument[] = [];
	const about = sorted.find((r) => r.kind === "about");
	if (about?.kind === "about") files.push(...aboutFiles(about.data));
	const skills = sorted.flatMap((r) =>
		r.kind === "skill" ? [r.data.name] : [],
	);
	if (skills.length > 0)
		files.push({
			path: SKILLS_PATH,
			content: joinBlocks("# Skills", bulletList(skills)),
		});
	for (const r of sorted) {
		if (r.kind === "experience") files.push(experienceFile(r.id, r.data));
		else if (r.kind === "project")
			files.push({
				path: recordPath(r),
				content: joinBlocks(
					`# ${oneLine(r.data.name)}`,
					r.data.description,
					bulletList(r.data.bullets),
				),
			});
		else if (r.kind === "education") {
			const e = r.data;
			const head = `- **${oneLine(e.field) || "Studies"}**, ${oneLine(e.school)}${oneLine(e.years) ? ` — ${oneLine(e.years)}` : ""}`;
			const note = oneLine(e.note) ? `\n  - ${oneLine(e.note)}` : "";
			files.push({
				path: recordPath(r),
				content: joinBlocks("# Education", `${head}${note}`),
			});
		} else if (r.kind === "extra")
			files.push({
				path: recordPath(r),
				content: joinBlocks(`# ${oneLine(r.data.title)}`, r.data.text),
			});
	}
	return files;
}

/* --------------------------------------------------------------- citations */

const squash = (text: string) =>
	text.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/**
 * The record a citation points at: the record whose file it names, or for skills.md the skill
 * whose line the quote is from. Null when the record is gone.
 */
export function recordForCitation(
	records: readonly ProfileRecord[],
	file: string,
	quote = "",
): ProfileRecord | null {
	if (file === ABOUT_PATH || file === SUMMARY_PATH)
		return records.find((r) => r.kind === "about") ?? null;
	if (file === SKILLS_PATH) {
		const q = squash(quote);
		return (
			records.find(
				(r) =>
					r.kind === "skill" &&
					(q.includes(squash(r.data.name)) || squash(r.data.name).includes(q)),
			) ?? null
		);
	}
	const id = file.match(
		/^(?:experience|projects|education|extras)\/(.+)\.md$/,
	)?.[1];
	return id ? (records.find((r) => r.id === id) ?? null) : null;
}

const RECORD_KIND_LABEL: Record<RecordKind, string> = {
	about: "About you",
	experience: "Experience",
	project: "Projects",
	skill: "Skills",
	education: "Education",
	extra: "Extras",
};

/** "Experience · Acme, Engineer": how a record is named wherever a claim cites it. */
export function recordLabel(record: ProfileRecord): string {
	const kind = RECORD_KIND_LABEL[record.kind];
	switch (record.kind) {
		case "about":
			return kind;
		case "experience":
			return `${kind} · ${[record.data.company, record.data.title].filter(Boolean).join(", ")}`;
		case "project":
			return `${kind} · ${record.data.name}`;
		case "skill":
			return `${kind} · ${record.data.name}`;
		case "education":
			return `${kind} · ${[record.data.school, record.data.field].filter(Boolean).join(", ")}`;
		case "extra":
			return `${kind} · ${record.data.title}`;
	}
}

/* ------------------------------------------------------------------ drafts */

/** A resume import's structured fields as draft records; nothing is saved until the user does. */
export function recordsFromStructured(
	profile: StructuredProfile,
	source: string,
): DraftRecord[] {
	const out: DraftRecord[] = [
		{
			kind: "about",
			source,
			data: aboutData.parse({ ...profile.personal, summary: profile.summary }),
		},
	];
	for (const name of profile.skills)
		if (listItem(name))
			out.push({ kind: "skill", source, data: { name: listItem(name) } });
	for (const role of profile.experience)
		if (oneLine(role.company))
			out.push({
				kind: "experience",
				source,
				data: experienceData.parse({ ...role, more: "" }),
			});
	for (const p of profile.projects)
		if (oneLine(p.name))
			out.push({ kind: "project", source, data: projectData.parse(p) });
	for (const e of profile.education)
		out.push({ kind: "education", source, data: educationData.parse(e) });
	if (profile.languages.length > 0)
		out.push({
			kind: "extra",
			source,
			data: { title: "Languages", text: bulletList(profile.languages) },
		});
	if (profile.notes.length > 0)
		out.push({
			kind: "extra",
			source,
			data: { title: "Notes", text: bulletList(profile.notes) },
		});
	return out;
}

/* ------------------------------------------------- Markdown profile import */

const FIELD = /^-[ \t]+\*\*([^*:]+):\*\*[ \t]*(.*)$/;
const ABOUT_FIELDS: Record<string, keyof AboutData> = {
	name: "name",
	email: "email",
	phone: "phone",
	linkedin: "linkedin",
	website: "website",
	github: "github",
	location: "location",
};

/** Body of a file without its first `# ` heading and its "From …" provenance line. */
function body(content: string): { title: string | null; text: string } {
	const lines = content.split("\n");
	const at = lines.findIndex((l) => l.trim() !== "");
	const heading = lines[at]?.match(/^#\s+(.+)$/);
	const rest = heading ? lines.slice(at + 1) : lines;
	// The provenance line renderProfileFiles wrote under the heading ("From a resume pasted…").
	const first = rest.findIndex((l) => l.trim() !== "");
	if (
		first !== -1 &&
		/^From (?:a|an|the) .+\.$/.test(rest[first]?.trim() ?? "")
	)
		rest.splice(first, 1);
	return { title: heading?.[1]?.trim() ?? null, text: rest.join("\n").trim() };
}

function titleFromPath(path: string): string {
	const base = path.replace(/\.md$/, "").split("/").at(-1) ?? path;
	return base.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Splits text at its `## ` headings: the part before the first one, then each section. */
function sections(text: string): {
	lead: string;
	parts: { heading: string; text: string }[];
} {
	const lines = text.split("\n");
	const lead: string[] = [];
	const parts: { heading: string; lines: string[] }[] = [];
	for (const l of lines) {
		const h = l.match(/^##\s+(.+)$/);
		if (h?.[1]) parts.push({ heading: h[1].trim(), lines: [] });
		else if (parts.length > 0) parts.at(-1)?.lines.push(l);
		else lead.push(l);
	}
	return {
		lead: lead.join("\n").trim(),
		parts: parts.map((p) => ({
			heading: p.heading,
			text: p.lines.join("\n").trim(),
		})),
	};
}

const isBullet = (l: string) => /^[-*][ \t]+/.test(l);
const unbullet = (l: string) => l.replace(/^[-*][ \t]+/, "").trim();

function parseExperience(content: string): ExperienceData | null {
	const { title, text } = body(content);
	const head = title?.match(/^(.+?)\s+[—–-]\s+(.+)$/);
	if (!head?.[1]) return null;
	const kept: string[] = [];
	let start = "";
	let end = "";
	let location = "";
	let bullets: string[] = [];
	const { lead, parts } = sections(text);
	for (const l of lead.split("\n")) {
		const f = l.match(FIELD);
		const label = f?.[1]?.trim().toLowerCase();
		if (label === "dates" && !start && !end) {
			const [a, b] = (f?.[2] ?? "").split(/\s+[–—-]\s+/);
			start = a?.trim() ?? "";
			end = b?.trim() ?? "";
		} else if (label === "location" && !location)
			location = f?.[2]?.trim() ?? "";
		else kept.push(l);
	}
	const rest: string[] = [kept.join("\n").trim()];
	for (const part of parts) {
		const lines = part.text.split("\n").filter((l) => l.trim());
		if (
			/^what i did$/i.test(part.heading) &&
			bullets.length === 0 &&
			lines.every(isBullet)
		)
			bullets = lines.map(unbullet);
		else rest.push(`## ${part.heading}\n\n${part.text}`.trim());
	}
	return experienceData.parse({
		company: head[1].trim(),
		title: head[2]?.trim() ?? "",
		start,
		end,
		location,
		bullets,
		more: rest.filter(Boolean).join("\n\n"),
	});
}

const EDUCATION =
	/^-[ \t]+\*\*([^*]+)\*\*,[ \t]+(.+?)(?:[ \t]+[—–-][ \t]+(.+))?$/;

function parseEducation(text: string): z.infer<typeof educationData>[] | null {
	const out: z.infer<typeof educationData>[] = [];
	for (const l of text.split("\n")) {
		if (!l.trim()) continue;
		const m = l.match(EDUCATION);
		if (m?.[1]) {
			out.push({
				field: m[1].trim(),
				school: m[2]?.trim() ?? "",
				years: m[3]?.trim() ?? "",
				note: "",
			});
			continue;
		}
		const note = l.match(/^[ \t]+[-*][ \t]+(.+)$/)?.[1];
		const last = out.at(-1);
		if (note && last && !last.note) {
			last.note = note.trim();
			continue;
		}
		return null;
	}
	return out;
}

/**
 * Draft records from a Markdown profile (the files the app kept before records, or a folder of
 * profile files). Deterministic, no model: what maps to a field becomes the field, and every
 * other line is kept word for word in the record's Markdown (`more`) or in an extra, so nothing
 * the claims check could cite is lost. `answers.md` is left out: answers are kept as facts.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep legacy profile parsing and record emission in order so evidence text and record boundaries remain stable.
export function recordsFromFiles(
	files: readonly ProfileDocument[],
	source: string,
): DraftRecord[] {
	const out: DraftRecord[] = [];
	const extra = (title: string, text: string) => {
		if (text.trim())
			out.push({ kind: "extra", source, data: { title, text: text.trim() } });
	};
	const about: AboutData = aboutData.parse({});
	const aboutMore: string[] = [];
	const evidence = files.filter(
		(f) => !/^(?:profile\/)?sources\//.test(f.path) && f.path !== "answers.md",
	);
	const ordered = [...evidence].sort((a, b) => b.path.localeCompare(a.path));
	for (const file of ordered) {
		const path = file.path.replace(/^profile\//, "");
		const { title, text } = body(file.content);
		if (path === "personal.md") {
			const rest: string[] = [];
			for (const l of text.split("\n")) {
				const f = l.match(FIELD);
				const key = f?.[1]
					? ABOUT_FIELDS[f[1].trim().toLowerCase()]
					: undefined;
				if (key && !about[key]) about[key] = f?.[2]?.trim() ?? "";
				else rest.push(l);
			}
			aboutMore.push(rest.join("\n").trim());
		} else if (path === "summary.md")
			about.summary =
				title && !/^summary$/i.test(title) ? `## ${title}\n\n${text}` : text;
		else if (path === "skills.md") {
			const { lead, parts } = sections(text);
			const leadLines = lead.split("\n").filter((l) => l.trim());
			if (leadLines.every(isBullet))
				for (const l of leadLines)
					out.push({ kind: "skill", source, data: { name: unbullet(l) } });
			else parts.unshift({ heading: "", text: lead });
			extra(
				title ?? "Skills",
				parts
					.map((p) => (p.heading ? `## ${p.heading}\n\n${p.text}` : p.text))
					.join("\n\n"),
			);
		} else if (path.startsWith("experience/")) {
			const role = parseExperience(file.content);
			if (role) out.push({ kind: "experience", source, data: role });
			else extra(title ?? titleFromPath(path), text);
		} else if (path === "education.md") {
			const entries = parseEducation(text);
			if (entries && entries.length > 0)
				for (const e of entries)
					out.push({ kind: "education", source, data: e });
			else extra(title ?? "Education", text);
		} else if (path === "projects.md") {
			const { lead, parts } = sections(text);
			extra(title ?? "Projects", lead);
			for (const p of parts) {
				const lines = p.text.split("\n");
				const bullets = lines.filter(isBullet);
				const description = lines
					.filter((l) => !isBullet(l))
					.join("\n")
					.trim();
				const rest = lines.filter(
					(l) => l.trim() && !isBullet(l) && /^\s/.test(l),
				);
				if (rest.length > 0) extra(p.heading, p.text);
				else
					out.push({
						kind: "project",
						source,
						data: projectData.parse({
							name: p.heading,
							description,
							bullets: bullets.map(unbullet),
						}),
					});
			}
		} else extra(title ?? titleFromPath(path), text);
	}
	about.more = aboutMore.filter(Boolean).join("\n\n");
	out.unshift({ kind: "about", source, data: about });
	return out;
}

/** A line as compared by `missingLines`: list or heading marker, dashes and spacing normalized. */
const comparable = (line: string) =>
	line
		.replace(/^\s*(?:[-*]|#+)[ \t]+/, "")
		.replace(/\s*[–—]\s*/g, " - ")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Lines of the original profile files that the rendered records no longer hold ("path: line"),
 * so a conversion can prove it kept everything. Section titles the layout writes itself and the
 * provenance line are not content.
 */
export function missingLines(
	original: readonly ProfileDocument[],
	rendered: readonly ProfileDocument[],
): string[] {
	const kept = new Set(
		rendered.flatMap((f) => f.content.split("\n").map(comparable)),
	);
	return original
		.filter(
			(f) =>
				!/^(?:profile\/)?sources\//.test(f.path) && f.path !== "answers.md",
		)
		.flatMap((f) =>
			f.content
				.split("\n")
				.filter(
					(l) =>
						l.trim() &&
						!/^#\s+(?:Personal|Summary|Skills|Education|Projects)\s*$/.test(
							l,
						) &&
						!/^From (?:a|an|the) .+\.$/.test(l.trim()) &&
						!kept.has(comparable(l)),
				)
				.map((l) => `${f.path}: ${l}`),
		);
}
