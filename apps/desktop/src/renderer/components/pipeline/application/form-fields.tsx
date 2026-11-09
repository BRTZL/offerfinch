import { InspectorSection } from "@/components/system/pane";
import type { AppDetail } from "./types";

type Form = NonNullable<AppDetail["form"]>;
type Line = Extract<Form, { status: "read" }>["fields"][number];

const SHOWN_IN = new Set([
	"ready_for_review",
	"approved",
	"applying",
	"needs_human",
	"applied",
]);

/** Where a value comes from, in words. */
function sourceLabel(line: Line): string {
	switch (line.source.kind) {
		case "contact":
			return "Your contact details";
		case "file":
			return line.source.file === "cv"
				? "Your approved CV"
				: "Your approved cover letter";
		case "form_answer":
			return "Form answers";
		case "profile_fact":
			return "Your saved answer";
		case "decline":
			return "Declined to self-identify";
		case "question":
			return "Waiting for your answer in Questions";
		case "blank":
			return "Optional";
	}
}

/** Fields grouped by page, then by the heading they sit under, in form order. */
function groups(fields: Line[]): { title: string; fields: Line[] }[] {
	const pages = new Set(fields.map((f) => f.page)).size > 1;
	const out: { title: string; fields: Line[] }[] = [];
	for (const field of fields) {
		const title = [pages ? `Page ${field.page}` : "", field.section]
			.filter(Boolean)
			.join(" · ");
		const last = out.at(-1);
		if (last && last.title === title) last.fields.push(field);
		else out.push({ title, fields: [field] });
	}
	return out;
}

/**
 * Review: every field of the application form and the exact value that will be sent, as read
 * before review (docs/auto-apply-plan.md, step 2). Approving approves this list.
 */
export function WhatWillBeSentSection({ app }: { app: AppDetail }) {
	const form = app.form;
	// A hand-off is submitted by the user: nothing is filled, so there is no list.
	if (!form || !SHOWN_IN.has(app.state) || app.submission?.mode !== "auto")
		return null;
	if (form.status !== "read")
		return (
			<InspectorSection
				title="What will be sent"
				data-testid="what-will-be-sent"
			>
				<p
					className="text-muted-foreground text-xs"
					data-testid="what-will-be-sent-note"
				>
					{form.note}
					{form.status === "failed"
						? " You approve the CV, letter and form answers; a required field they do not answer stops the run and comes to you."
						: null}
				</p>
			</InspectorSection>
		);
	return (
		<InspectorSection
			title="What will be sent"
			end={form.fields.length}
			data-testid="what-will-be-sent"
		>
			<p className="text-muted-foreground text-xs">
				Every field on the form and the exact value it gets. A required field
				the form adds later stops the run; it is never answered on the fly.
			</p>
			{groups(form.fields).map((group) => (
				<div
					key={`${group.title}-${group.fields[0]?.key}`}
					className="flex flex-col gap-2"
				>
					{group.title ? (
						<div className="text-2xs text-muted-foreground font-medium">
							{group.title}
						</div>
					) : null}
					<dl className="flex flex-col gap-2 text-xs">
						{group.fields.map((line) => (
							<div
								key={line.key}
								data-testid="sent-field"
								data-source={line.source.kind}
							>
								<dt className="text-foreground font-medium">
									{line.label}
									{line.required ? (
										<span className="text-muted-foreground"> · required</span>
									) : null}
								</dt>
								<dd
									className={
										line.value === null
											? "text-muted-foreground italic"
											: "text-foreground break-words whitespace-pre-wrap"
									}
									data-testid="sent-value"
								>
									{line.value ?? "left blank"}
								</dd>
								<dd className="text-2xs text-muted-foreground">
									{sourceLabel(line)}
								</dd>
							</div>
						))}
					</dl>
				</div>
			))}
			{form.submit ? (
				<p className="text-2xs text-muted-foreground">
					Then "{form.submit}" is clicked once.
				</p>
			) : null}
		</InspectorSection>
	);
}
