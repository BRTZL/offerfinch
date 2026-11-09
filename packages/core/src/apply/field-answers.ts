import type { FormAnswer } from "../tailor/tailor";
import type { FormRead, FormSchema, SchemaField } from "./form-schema";
import {
	type ApplicantData,
	declineOption,
	exactOption,
	type FieldKind,
	type FillAction,
	findAnswer,
	planFill,
	sameQuestion,
	systemRole,
	type UnknownQuestion,
} from "./forms";

/**
 * Answers per field (docs/auto-apply-plan.md, step 3): every field of the form read before review
 * gets an approved value, or is left blank, or becomes a question for the user. Never a guess.
 * The values come from `planFill`, the same function the submission fills the form with, so the
 * "What will be sent" list is what the run types.
 */

/** A saved answer from the question inbox (`profile_facts`), with its record id. */
export interface SavedAnswer extends FormAnswer {
	id?: string;
}

export type FieldSource =
	| { kind: "contact" }
	| { kind: "file"; file: "cv" | "cover_letter" }
	/** An answer in the approved form answers. */
	| { kind: "form_answer" }
	/** A saved answer: the profile fact it comes from, copied into the form answers. */
	| { kind: "profile_fact"; id: string | null }
	/** A self-identification question answered with its own "decline" option. */
	| { kind: "decline" }
	/** Optional, and nothing approved answers it. */
	| { kind: "blank" }
	/** Required, and nothing approved answers it: asked in Questions before review. */
	| { kind: "question" };

/** One line of "What will be sent". `value` null: left blank. */
export interface SentField {
	key: string;
	label: string;
	kind: FieldKind;
	required: boolean;
	page: number;
	section: string;
	value: string | null;
	source: FieldSource;
}

export interface FieldPlan {
	fields: SentField[];
	/** Saved answers the form needs that the form answers lack: added as a new version. */
	add: (FormAnswer & { sourceId: string | null })[];
	/** Required fields nothing answers: questions for the user. */
	ask: UnknownQuestion[];
}

/** Strips the " (one of: …)" suffix a form question gets in the inbox. */
const labelOf = (question: string) =>
	question.replace(/\s*\(one of: [^)]*\)\s*$/, "").trim();

/** A saved answer that fits this field: the same question, and one of its options when it has any. */
function savedFor(
	field: SchemaField,
	saved: SavedAnswer[],
): SavedAnswer | null {
	const fact = saved.find((s) =>
		sameQuestion(labelOf(s.question), field.label),
	);
	if (!fact) return null;
	if (
		field.options.length === 0 ||
		field.kind === "text" ||
		field.kind === "textarea"
	)
		return fact;
	const parts =
		field.kind === "checkbox"
			? fact.answer.split(/\n|;/).map((p) => p.trim())
			: [fact.answer];
	return parts.every((p) => exactOption(p, field.options)) ? fact : null;
}

/** Custom questions (not contact, file or self-identification) the form asks. */
function customQuestion(field: SchemaField): boolean {
	return systemRole(field) === null;
}

/**
 * The form's custom questions nothing deterministic answers yet (no approved form answer, no
 * saved answer): what the drafting model is asked to answer from the profile.
 */
export function openFormQuestions(
	schema: FormSchema,
	answers: FormAnswer[],
	saved: SavedAnswer[],
): { label: string; required: boolean; options: string[] }[] {
	return schema.fields
		.filter(
			(f) =>
				customQuestion(f) &&
				!findAnswer(f.label, answers) &&
				!savedFor(f, saved),
		)
		.map((f) => ({ label: f.label, required: f.required, options: f.options }));
}

/** Saved answers for the fields the form answers lack (custom and self-identification questions). */
function savedAdditions(
	schema: FormSchema,
	answers: FormAnswer[],
	saved: SavedAnswer[],
): FieldPlan["add"] {
	const add: FieldPlan["add"] = [];
	for (const field of schema.fields) {
		const role = systemRole(field);
		if (role !== null && role !== "voluntary") continue;
		if (findAnswer(field.label, [...answers, ...add])) continue;
		const fact = savedFor(field, saved);
		if (fact)
			add.push({
				question: field.label,
				answer: fact.answer,
				sourceId: fact.id ?? null,
			});
	}
	return add;
}

function sentValue(action: FillAction): string {
	switch (action.kind) {
		case "file":
			return action.file === "cv" ? "CV.pdf" : "Cover letter.pdf";
		case "choose":
			return action.values.join("; ");
		case "clear":
			return "";
		default:
			return action.value;
	}
}

/** Where a filled value comes from. */
function sourceOf(
	field: SchemaField,
	action: FillAction,
	value: string,
	context: { answers: FormAnswer[]; add: FieldPlan["add"] },
): FieldSource {
	if (action.kind === "file") return { kind: "file", file: action.file };
	const role = systemRole(field);
	if (role !== null && role !== "voluntary") return { kind: "contact" };
	const added = context.add.find((a) => sameQuestion(a.question, field.label));
	if (added) return { kind: "profile_fact", id: added.sourceId };
	const declined =
		role === "voluntary" &&
		!findAnswer(field.label, context.answers) &&
		value === declineOption(field);
	return declined ? { kind: "decline" } : { kind: "form_answer" };
}

/**
 * Maps every schema field to its value. Order of sources: contact details and approved files,
 * the approved form answers, then saved answers (which join the form answers so the claims check
 * and the approval cover them), then a self-identification field's "decline" option. A required
 * field still unanswered is a question.
 */
export function planFormFields(
	schema: FormSchema,
	data: ApplicantData,
	saved: SavedAnswer[],
): FieldPlan {
	const add = savedAdditions(schema, data.answers, saved);
	const answers = [
		...data.answers,
		...add.map(({ question, answer }) => ({ question, answer })),
	];
	const plan = planFill(
		schema.fields,
		{ ...data, answers },
		{ declineVoluntary: true },
	);
	const actions = new Map(plan.actions.map((a) => [a.ref, a]));
	const asked = new Set(plan.unknown.map((q) => q.label));
	const fields: SentField[] = [];
	for (const field of schema.fields) {
		if (systemRole(field) === "ignore") continue;
		const action = actions.get(field.ref);
		const label = field.label || field.name;
		const line = {
			key: field.key,
			label,
			kind: field.kind,
			required: field.required,
			page: field.page,
			section: field.section,
		};
		if (!action || action.kind === "clear") {
			fields.push({
				...line,
				value: null,
				source: asked.has(label) ? { kind: "question" } : { kind: "blank" },
			});
			continue;
		}
		const value = sentValue(action);
		fields.push({
			...line,
			value,
			source: sourceOf(field, action, value, { answers: data.answers, add }),
		});
	}
	return { fields, add, ask: plan.unknown };
}

/** The approved list's state for review: the fields and values, or why there is none. */
export type WhatWillBeSent =
	| {
			status: "read";
			fields: SentField[];
			submit: string | null;
			readAt: string;
	  }
	| { status: "failed" | "skipped"; note: string; readAt: string };

/**
 * "What will be sent", as review shows it: each value exactly as the submission fills it, from
 * the current form answers (saved answers already joined them while preparing). A value equal to
 * a saved answer for that question cites the profile fact it came from.
 */
export function whatWillBeSent(
	read: FormRead,
	data: ApplicantData,
	saved: SavedAnswer[],
): WhatWillBeSent {
	if (read.status !== "read")
		return { status: read.status, note: read.note, readAt: read.readAt };
	const { fields } = planFormFields(read.schema, data, []);
	return {
		status: "read",
		submit: read.schema.submit,
		readAt: read.readAt,
		fields: fields.map((f) => {
			if (f.source.kind !== "form_answer" || f.value === null) return f;
			const fact = saved.find(
				(s) =>
					s.answer === f.value && sameQuestion(labelOf(s.question), f.label),
			);
			return fact
				? { ...f, source: { kind: "profile_fact", id: fact.id ?? null } }
				: f;
		}),
	};
}
