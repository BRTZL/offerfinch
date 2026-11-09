import {
	type Board,
	type FieldKind,
	type FormField,
	questionKeyOf,
	systemRole,
} from "./forms";

/**
 * The form schema saved per application before review (docs/auto-apply-plan.md, step 2), and how
 * the live form is lined up with it at submit time.
 */

/** One question of the form as read before review. */
export interface SchemaField extends FormField {
	/** Stable across reads of the same form: kind and control name, else kind and label. */
	key: string;
	/** The form's page (1 for the single-page boards). */
	page: number;
	section: string;
}

export interface FormSchema {
	board: Board;
	url: string;
	fields: SchemaField[];
	/** The submit control's text; null when the form shows none. */
	submit: string | null;
}

/** The saved outcome of reading one application's form. */
export type FormRead =
	| { status: "read"; schema: FormSchema; readAt: string }
	| {
			status: "failed" | "skipped";
			board: string;
			url: string;
			/** Shown in review: why the field list is missing. */
			note: string;
			readAt: string;
	  };

/**
 * A control name with its per-load part removed: Ashby prefixes its EEO radio names with a UUID
 * that changes on every page load (`<uuid>__systemfield_eeoc_gender`, seen 2026-11-09).
 */
const PER_LOAD_PREFIX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_(?=_)/i;

/** The stable key of a field: what the same question is called on every read of the form. */
export function schemaKey(
	field: Pick<FormField, "kind" | "name" | "label">,
): string {
	const name = field.name.replace(PER_LOAD_PREFIX, "");
	return `${field.kind}:${name || `label:${questionKeyOf(field.label)}`}`;
}

/**
 * Lines the live form up with the approved schema at submit time. A combobox's options (read
 * only when it is opened) come from the schema. `unexpected` lists the required questions the
 * live form asks that the approved schema does not have: the run stops on them, they are never
 * answered on the fly. `unreviewed` holds the refs of the optional ones: nothing is typed into
 * them (only a value the page put there is cleared), since no value for them was approved.
 */
export function alignWithSchema(
	live: FormField[],
	schema: SchemaField[],
): {
	fields: FormField[];
	unexpected: { label: string; kind: FieldKind }[];
	unreviewed: Set<string>;
} {
	const byKey = new Map(schema.map((f) => [f.key, f]));
	const unexpected: { label: string; kind: FieldKind }[] = [];
	const unreviewed = new Set<string>();
	const fields = live.map((field) => {
		const known = byKey.get(schemaKey(field));
		if (!known) {
			if (field.required && systemRole(field) !== "ignore")
				unexpected.push({ label: field.label || field.name, kind: field.kind });
			else unreviewed.add(field.ref);
			return field;
		}
		return field.kind === "combobox" && field.options.length === 0
			? { ...field, options: known.options }
			: field;
	});
	return { fields, unexpected, unreviewed };
}
