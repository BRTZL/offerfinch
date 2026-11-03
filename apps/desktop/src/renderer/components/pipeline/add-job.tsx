import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { PasteFor } from "@/components/pipeline/added";
import { ErrorLine } from "@/components/system/bits";
import { FormRow } from "@/components/system/rows";
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
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { useRouter } from "@/lib/router";

type Pasted = {
	title: string;
	company: string;
	location: string;
	description: string;
};
const EMPTY: Pasted = { title: "", company: "", location: "", description: "" };

/**
 * Add job from link: postings the user chose. Links are checked here (a link to this Mac or a
 * private network is refused, one already added opens), then the dialog closes and each job
 * appears at the top of the Inbox while its posting is read, checked against the job search
 * and scored in the background. The posting's text can be pasted instead, for a new link or
 * for one whose page could not be read (`pasteFor`).
 */
export function AddJobDialog({
	open,
	onOpenChange,
	pasteFor,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pasteFor?: PasteFor | null;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [links, setLinks] = useState("");
	const [url, setUrl] = useState("");
	const [mode, setMode] = useState<"link" | "paste">("link");
	const [pasted, setPasted] = useState<Pasted>(EMPTY);
	useEffect(() => {
		if (!open) return;
		if (pasteFor) {
			setMode("paste");
			setUrl(pasteFor.url);
			setPasted({
				...EMPTY,
				title: /[/.]/.test(pasteFor.title ?? "") ? "" : (pasteFor.title ?? ""),
				description: pasteFor.description ?? "",
			});
			return;
		}
		setMode("link");
		setPasted(EMPTY);
		// A link on the clipboard is the likeliest thing to add.
		void desktop
			.clipboardLink?.()
			.then((link) => link && setLinks((u) => u || link))
			.catch(() => {});
	}, [open, pasteFor]);

	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: orpc.inbox.key() });
		await queryClient.invalidateQueries({ queryKey: ["inbox"] });
		await queryClient.invalidateQueries({ queryKey: orpc.application.key() });
	};
	const open_ = (id: string) => router.push(`/applications/${id}?view=all`);

	const addLinks = useMutation({
		mutationFn: () => client.jobs.addLinks({ text: links }),
		onSuccess: async (results) => {
			const added = results.filter((r) => r.status === "added");
			const existing = results.filter((r) => r.status === "exists");
			const refused = results.filter((r) => r.status === "refused");
			if (added.length === 0 && existing.length === 0) return; // refusals stay in the dialog
			onOpenChange(false);
			setLinks("");
			await refresh();
			const first = added[0] ?? existing[0];
			if (first) open_(first.applicationId);
			if (added.length > 0)
				toast.success(
					added.length === 1
						? "Added to Inbox. Reading the posting in the background."
						: `${added.length} jobs added to Inbox. Reading them in the background.`,
				);
			if (existing.length > 0)
				toast(
					existing.length === 1
						? "Already in your Inbox."
						: `${existing.length} were already in your Inbox.`,
				);
			for (const r of refused)
				toast.error(`Not added: ${r.url}. ${"reason" in r ? r.reason : ""}`);
		},
	});
	const refusedNow =
		addLinks.data?.every((r) => r.status === "refused") &&
		addLinks.data.length > 0
			? addLinks.data
			: null;

	const addPasted = useMutation({
		mutationFn: async () => {
			const body = {
				title: pasted.title,
				company: pasted.company,
				location: pasted.location || undefined,
				description: pasted.description,
			};
			if (pasteFor) {
				await client.jobs.pasteFor({
					id: pasteFor.applicationId,
					pasted: body,
				});
				return {
					status: "pasted" as const,
					applicationId: pasteFor.applicationId,
				};
			}
			return client.jobs.addPasted({ url, pasted: body });
		},
		onSuccess: async (result) => {
			if (result.status === "refused") return;
			onOpenChange(false);
			await refresh();
			open_(result.applicationId);
			if (result.status === "pasted") {
				toast.success("Saved. Checking it against your job search now.");
				return;
			}
			const first =
				result.status === "added"
					? "Added to Inbox."
					: "Already in your Inbox.";
			toast.success(
				result.filter.matches
					? `${first} It matches your job search; the fit score follows.`
					: `${first} Doesn't match your job search: ${result.filter.summary}`,
				{ duration: 8_000 },
			);
		},
	});
	const pending = addLinks.isPending || addPasted.isPending;
	const pasteRefused =
		addPasted.data?.status === "refused" ? addPasted.data.reason : null;
	const ready =
		mode === "link"
			? links.trim().length > 0
			: url.trim().length > 0 &&
				pasted.title.trim() &&
				pasted.company.trim() &&
				pasted.description.trim().length >= 80;
	const set = (key: keyof Pasted) => (value: string) =>
		setPasted((p) => ({ ...p, [key]: value }));
	const submit = () => {
		if (!ready || pending) return;
		if (mode === "link") addLinks.mutate();
		else addPasted.mutate();
	};

	return (
		<Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
			<DialogContent data-testid="add-job">
				<DialogHeader>
					<DialogTitle>
						{pasteFor ? "Paste the posting" : "Add jobs from links"}
					</DialogTitle>
					<DialogDescription>
						{pasteFor
							? "The page couldn't be read. Paste its text; it is checked against your job search and scored like any other match."
							: "Postings you found yourself. They are read in the background, checked against your job search and scored."}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<form
						id="add-job-form"
						className="flex flex-col gap-3 pb-1"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						{mode === "link" ? (
							<>
								<FormRow
									label="Links"
									hint="One per line"
									htmlFor="add-job-url"
									layout="stack"
								>
									<Textarea
										id="add-job-url"
										value={links}
										autoFocus
										rows={3}
										spellCheck={false}
										className="min-h-20 resize-none font-mono text-xs"
										placeholder="https://"
										disabled={pending}
										onChange={(e) => setLinks(e.target.value)}
										onKeyDown={(e) => {
											// Enter adds; Shift+Enter starts another line.
											if (e.key === "Enter" && !e.shiftKey) {
												e.preventDefault();
												submit();
											}
										}}
										data-testid="add-job-url"
									/>
								</FormRow>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="-ml-2.5 self-start"
									onClick={() => {
										setUrl(links.trim().split(/\s+/)[0] ?? "");
										setMode("paste");
									}}
									disabled={pending}
									data-testid="add-job-paste-toggle"
								>
									Paste the posting's text instead
								</Button>
							</>
						) : (
							<>
								<FormRow label="Link" htmlFor="add-job-link" layout="stack">
									<Input
										id="add-job-link"
										value={url}
										spellCheck={false}
										placeholder="https://"
										disabled={pending || Boolean(pasteFor)}
										onChange={(e) => setUrl(e.target.value)}
										data-testid="add-job-link"
									/>
								</FormRow>
								<div className="grid grid-cols-2 gap-3">
									<FormRow
										label="Job title"
										htmlFor="add-job-title"
										layout="stack"
									>
										<Input
											id="add-job-title"
											value={pasted.title}
											autoFocus={Boolean(pasteFor)}
											onChange={(e) => set("title")(e.target.value)}
											data-testid="add-job-title"
										/>
									</FormRow>
									<FormRow
										label="Company"
										htmlFor="add-job-company"
										layout="stack"
									>
										<Input
											id="add-job-company"
											value={pasted.company}
											onChange={(e) => set("company")(e.target.value)}
											data-testid="add-job-company"
										/>
									</FormRow>
								</div>
								<FormRow
									label="Location"
									hint="Optional"
									htmlFor="add-job-location"
									layout="stack"
								>
									<Input
										id="add-job-location"
										value={pasted.location}
										placeholder="Remote, or a city"
										onChange={(e) => set("location")(e.target.value)}
										data-testid="add-job-location"
									/>
								</FormRow>
								<FormRow
									label="The posting"
									htmlFor="add-job-text"
									layout="stack"
								>
									<Textarea
										id="add-job-text"
										className="min-h-40 resize-none text-sm"
										value={pasted.description}
										placeholder="Paste the whole posting: what the job is, the requirements, where."
										onChange={(e) => set("description")(e.target.value)}
										data-testid="add-job-text"
									/>
								</FormRow>
								{pasteFor ? null : (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="-ml-2.5 self-start"
										onClick={() => {
											setLinks((l) => l || url);
											setMode("link");
										}}
										disabled={pending}
									>
										<ChevronLeft />
										Read the link instead
									</Button>
								)}
							</>
						)}
						{refusedNow ? (
							<ErrorLine>
								{refusedNow
									.map((r) => ("reason" in r ? r.reason : ""))
									.filter((r, i, all) => all.indexOf(r) === i)
									.join(" ")}
							</ErrorLine>
						) : pasteRefused ? (
							<ErrorLine>{pasteRefused}</ErrorLine>
						) : addLinks.error ? (
							<ErrorLine>{addLinks.error.message}</ErrorLine>
						) : addPasted.error ? (
							<ErrorLine>{addPasted.error.message}</ErrorLine>
						) : null}
					</form>
				</DialogBody>
				<DialogFooter>
					<DialogClose disabled={pending}>Cancel</DialogClose>
					<Button
						type="submit"
						form="add-job-form"
						disabled={!ready}
						pending={pending}
						data-testid="add-job-submit"
					>
						{pasteFor ? "Save" : "Add"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
