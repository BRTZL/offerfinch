import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { MarkdownField } from "@/components/system/markdown";
import { FormRow } from "@/components/system/rows";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";

export type RecordKind =
	| "about"
	| "experience"
	| "project"
	| "skill"
	| "education"
	| "extra";

/** A record as the app edits it: its fields as strings, bullets one per line. */
export type Fields = Record<string, string>;

type Field = {
	key: string;
	label: string;
	hint?: string;
	long?: boolean;
	placeholder?: string;
};

export const FIELDS: Record<RecordKind, Field[]> = {
	about: [
		{ key: "name", label: "Name" },
		{ key: "location", label: "Location", placeholder: "City, Country" },
		{ key: "email", label: "Email" },
		{ key: "phone", label: "Phone" },
		{ key: "linkedin", label: "LinkedIn" },
		{ key: "website", label: "Website" },
		{ key: "github", label: "GitHub" },
		{
			key: "summary",
			label: "Summary",
			long: true,
			hint: "Two or three sentences about your work, only what is true.",
		},
		{
			key: "more",
			label: "More about you",
			long: true,
			hint: "Work authorization, notice period, anything an application asks. Markdown.",
		},
	],
	experience: [
		{ key: "company", label: "Company" },
		{ key: "title", label: "Title" },
		{ key: "start", label: "Start", placeholder: "Jan 2021" },
		{ key: "end", label: "End", placeholder: "Empty while you work there" },
		{
			key: "location",
			label: "Location",
			placeholder: "City, Country or Remote",
		},
		{
			key: "bullets",
			label: "What you did",
			long: true,
			hint: "One line each. Results and numbers exactly as they were.",
		},
		{
			key: "more",
			label: "More",
			long: true,
			hint: "Anything else about this role, in Markdown. Drafts may cite it.",
		},
	],
	project: [
		{ key: "name", label: "Name" },
		{ key: "description", label: "Description", long: true },
		{ key: "bullets", label: "Highlights", long: true, hint: "One line each." },
	],
	skill: [{ key: "name", label: "Skill", placeholder: "TypeScript" }],
	education: [
		{ key: "school", label: "School" },
		{ key: "field", label: "Field of study" },
		{ key: "years", label: "Years", placeholder: "2014 – 2018" },
		{
			key: "note",
			label: "Note",
			hint: "Say whether you completed a degree; drafts never claim one you did not.",
		},
	],
	extra: [
		{ key: "title", label: "Title", placeholder: "Languages, Certificates…" },
		{ key: "text", label: "Text", long: true, hint: "Markdown." },
	],
};

export const KIND_NOUN: Record<RecordKind, string> = {
	about: "About you",
	experience: "role",
	project: "project",
	skill: "skill",
	education: "education entry",
	extra: "extra",
};

const REQUIRED: Partial<Record<RecordKind, string>> = {
	experience: "company",
	project: "name",
	skill: "name",
	extra: "title",
};

/** Saved data as form strings. */
function toFields(data: Record<string, unknown>): Fields {
	return Object.fromEntries(
		Object.entries(data).map(([k, v]) => [
			k,
			Array.isArray(v) ? v.join("\n") : String(v ?? ""),
		]),
	);
}

/** Form strings as the record's data. */
function toData(kind: RecordKind, fields: Fields): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const f of FIELDS[kind]) {
		const value = fields[f.key] ?? "";
		data[f.key] =
			f.key === "bullets"
				? value
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean)
				: value.trim();
	}
	return data;
}

const day = (value: string | Date) =>
	new Date(value).toISOString().slice(0, 10);

/**
 * Add or edit one record in a sheet. Saving dates it today with you as the source; a review that
 * cited the old text stops approval until it is checked again.
 */
export function RecordDialog({
	kind,
	record,
	open,
	onOpenChange,
}: {
	kind: RecordKind;
	record?: {
		id: string;
		data: Record<string, unknown>;
		source: string;
		sourceDate: string | Date;
	};
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const [fields, setFields] = useState<Fields>(() =>
		record ? toFields(record.data) : {},
	);
	const done = (message: string) => {
		toast.success(message);
		onOpenChange(false);
		void queryClient.invalidateQueries({ queryKey: orpc.profile.key() });
		void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
	};
	const save = useMutation({
		mutationFn: () => {
			const input = { kind, data: toData(kind, fields) } as Parameters<
				typeof client.profile.addRecord
			>[0];
			return record
				? client.profile.updateRecord({ id: record.id, record: input })
				: client.profile.addRecord(input);
		},
		onSuccess: () =>
			done(record ? "Saved, dated today." : "Added, dated today."),
		onError: (error) => toast.error(error.message),
	});
	const remove = useMutation({
		mutationFn: () => client.profile.removeRecord({ id: record?.id ?? "" }),
		onSuccess: () => done("Removed from your profile."),
		onError: (error) => toast.error(error.message),
	});
	const required = REQUIRED[kind];
	const missing = required ? !(fields[required] ?? "").trim() : false;
	const noun = KIND_NOUN[kind];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-testid="record-dialog">
				<DialogHeader>
					<DialogTitle>
						{kind === "about"
							? "About you"
							: record
								? `Edit ${noun}`
								: `Add a ${noun}`}
					</DialogTitle>
					<DialogDescription>
						Drafts may say only what your profile says. Keep it exact.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<form
						id="record-form"
						className="flex flex-col gap-5 pb-1"
						onSubmit={(e) => {
							e.preventDefault();
							if (!missing) save.mutate();
						}}
					>
						{FIELDS[kind].map((f) => (
							<FormRow
								key={f.key}
								label={f.label}
								hint={f.hint}
								htmlFor={`record-${f.key}`}
								layout="stack"
								// Edge to edge with the dialog's title and buttons, not inset like a
								// settings group's rows.
								className="min-h-0 px-0 py-0"
							>
								{f.long && f.key === "bullets" ? (
									// One line each, not Markdown: a plain text area.
									<Textarea
										id={`record-${f.key}`}
										className="min-h-24"
										value={fields[f.key] ?? ""}
										placeholder={f.placeholder}
										onChange={(e) =>
											setFields({ ...fields, [f.key]: e.target.value })
										}
										data-testid={`record-${f.key}`}
									/>
								) : f.long ? (
									<MarkdownField
										id={`record-${f.key}`}
										value={fields[f.key] ?? ""}
										placeholder={f.placeholder}
										onChange={(value) =>
											setFields({ ...fields, [f.key]: value })
										}
										testId={`record-${f.key}`}
									/>
								) : (
									<Input
										id={`record-${f.key}`}
										value={fields[f.key] ?? ""}
										placeholder={f.placeholder}
										onChange={(e) =>
											setFields({ ...fields, [f.key]: e.target.value })
										}
										data-testid={`record-${f.key}`}
									/>
								)}
							</FormRow>
						))}
					</form>
				</DialogBody>
				<DialogFooter>
					{record ? (
						<span className="text-muted-foreground mr-auto text-xs">
							From {record.source}, {day(record.sourceDate)}
						</span>
					) : null}
					{record && kind !== "about" ? (
						<AlertDialog>
							<AlertDialogTrigger
								render={<Button variant="ghost" data-testid="record-remove" />}
							>
								Remove
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Remove this {noun}?</AlertDialogTitle>
									<AlertDialogDescription>
										New drafts can no longer cite it. A draft whose check cited
										it waits for a new check before you can approve it.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Keep it</AlertDialogCancel>
									<AlertDialogAction
										variant="destructive"
										onClick={() => remove.mutate()}
										data-testid="record-remove-confirm"
									>
										Remove
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					) : null}
					<DialogClose>Cancel</DialogClose>
					<Button
						type="submit"
						form="record-form"
						disabled={missing}
						pending={save.isPending}
						data-testid="record-save"
					>
						{record ? "Save" : "Add"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
