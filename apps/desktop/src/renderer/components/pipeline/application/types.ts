import type { client } from "@/lib/orpc";

export type AppDetail = Awaited<ReturnType<typeof client.application.get>>;

export type Kind = "cv" | "cover_letter" | "form_answers" | "notes";

export const DOC_LABEL: Record<string, string> = {
	cv: "CV",
	cover_letter: "Cover letter",
	form_answers: "Form answers",
	notes: "Fit notes",
};
