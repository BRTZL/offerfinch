import {
	AVOID_WORD_CHARS,
	AVOID_WORDS_MAX,
	GUIDANCE_CHARS,
	type LetterLength,
	type WritingTone,
} from "@offerfinch/core/tailor/writing-style-options";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Field,
	QueryState,
	SettingsPage,
} from "@/components/pipeline/settings/shared";
import { ErrorLine } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TagInputField } from "@/components/ui/tag-input";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";

type Style = Awaited<ReturnType<typeof client.writingStyle.get>>;

const TONES: { value: WritingTone; label: string }[] = [
	{ value: "plain", label: "Plain" },
	{ value: "formal", label: "Formal" },
	{ value: "warm", label: "Warm" },
];

const TONE_HINT: Record<WritingTone, string> = {
	plain: "Direct and specific, like a note to a peer.",
	formal: "Polite and professional, with no contractions.",
	warm: "Friendly and personal, without adding feelings your profile does not state.",
};

const LENGTHS: { value: LetterLength; label: string }[] = [
	{ value: "shorter", label: "Shorter" },
	{ value: "standard", label: "Standard" },
	{ value: "fuller", label: "Fuller" },
];

const LENGTH_HINT: Record<LetterLength, string> = {
	shorter: "About 250 to 290 words.",
	standard: "About 300 words.",
	fuller: "About 330 to 380 words.",
};

/** What the limits refuse, before a save is tried. */
function problemsOf(style: Style): string[] {
	const out: string[] = [];
	if (style.avoidWords.length > AVOID_WORDS_MAX)
		out.push(`At most ${AVOID_WORDS_MAX} words to avoid.`);
	const long = style.avoidWords.find((w) => w.length > AVOID_WORD_CHARS);
	if (long)
		out.push(
			`"${long.slice(0, 20)}…" is too long: at most ${AVOID_WORD_CHARS} characters each.`,
		);
	if (style.guidance.length > GUIDANCE_CHARS)
		out.push(`Guidance is at most ${GUIDANCE_CHARS} characters.`);
	return out;
}

/**
 * How drafts read: tone, the cover letter's length inside the fixed 220 to 400 words, words to
 * avoid, and the user's own always/never guidance. A preference only: the profile stays the only
 * source of facts, and every draft is checked as before. A save applies to the next draft.
 */
export function WritingSettings() {
	const queryClient = useQueryClient();
	const stored = useQuery(orpc.writingStyle.get.queryOptions());
	const [form, setForm] = useState<Style | null>(null);
	useEffect(() => {
		if (stored.data && !form) setForm(stored.data);
	}, [stored.data, form]);
	const save = useMutation({
		mutationFn: (value: Style) => client.writingStyle.set(value),
		onSuccess: (value) => {
			setForm(value);
			toast.success("Saved. The next draft uses it; drafts already made stay.");
			void queryClient.invalidateQueries({ queryKey: orpc.writingStyle.key() });
		},
		onError: (error) => toast.error(error.message),
	});
	const set = <K extends keyof Style>(key: K, value: Style[K]) =>
		setForm((f) => (f ? { ...f, [key]: value } : f));
	const problems = form ? problemsOf(form) : [];
	return (
		<SettingsPage
			id="writing"
			title="Writing"
			description="How your CV, cover letter and answers read. Facts still come only from your profile, and every draft is checked as before."
		>
			<QueryState
				isLoading={stored.isLoading}
				error={stored.error}
				what="the writing style"
			/>
			{form && (
				<form
					className="flex flex-col gap-8"
					onSubmit={(e) => {
						e.preventDefault();
						if (problems.length === 0) save.mutate(form);
					}}
				>
					<Section title="Style">
						<Group>
							<Field id="w-tone" label="Tone" hint={TONE_HINT[form.tone]}>
								<Select
									value={form.tone}
									onValueChange={(next) => {
										if (next) set("tone", next as WritingTone);
									}}
									items={TONES}
								>
									<SelectTrigger
										id="w-tone"
										aria-label="Tone"
										className="w-44"
										data-testid="writing-tone"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{TONES.map((t) => (
											<SelectItem
												key={t.value}
												value={t.value}
												data-testid={`writing-tone-${t.value}`}
											>
												{t.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
							<Field
								id="w-length"
								label="Cover letter length"
								hint={`${LENGTH_HINT[form.coverLetterLength]} Always within 220 to 400 words.`}
							>
								<Select
									value={form.coverLetterLength}
									onValueChange={(next) => {
										if (next) set("coverLetterLength", next as LetterLength);
									}}
									items={LENGTHS}
								>
									<SelectTrigger
										id="w-length"
										aria-label="Cover letter length"
										className="w-44"
										data-testid="writing-length"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{LENGTHS.map((l) => (
											<SelectItem
												key={l.value}
												value={l.value}
												data-testid={`writing-length-${l.value}`}
											>
												{l.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						</Group>
					</Section>
					<Section title="Your rules">
						<Group>
							<Field
								id="w-avoid"
								label="Words to avoid"
								hint={`Never used in a draft. Press Enter or a comma after each. Up to ${AVOID_WORDS_MAX}.`}
							>
								<TagInputField
									id="w-avoid"
									aria-label="Words to avoid"
									data-testid="writing-avoid"
									className="w-96"
									value={form.avoidWords}
									onValueChange={(v) => set("avoidWords", v)}
									placeholder="None"
								/>
							</Field>
							<Field
								id="w-guidance"
								label="Guidance"
								layout="stack"
								hint="Always or never, in your words. It shapes the wording only; it cannot add a fact."
							>
								<Textarea
									id="w-guidance"
									aria-label="Guidance"
									data-testid="writing-guidance"
									className="min-h-24 w-full"
									value={form.guidance}
									maxLength={GUIDANCE_CHARS}
									placeholder="Always use British spelling. Never open with my current job title."
									onChange={(e) => set("guidance", e.target.value)}
								/>
								<span className="text-muted-foreground ml-auto text-xs tabular-nums">
									{form.guidance.length} / {GUIDANCE_CHARS}
								</span>
							</Field>
						</Group>
					</Section>
					{problems.map((p) => (
						<ErrorLine key={p}>{p}</ErrorLine>
					))}
					<div>
						<Button
							type="submit"
							pending={save.isPending}
							disabled={problems.length > 0}
							data-testid="save-writing"
						>
							Save
						</Button>
					</div>
				</form>
			)}
		</SettingsPage>
	);
}
