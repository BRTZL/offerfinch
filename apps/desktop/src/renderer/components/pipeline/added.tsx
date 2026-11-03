import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { client, orpc } from "@/lib/orpc";
import { useRouter } from "@/lib/router";

/**
 * Jobs the user added by link, while their posting is read and checked in the background: the
 * step they are on, and what to do when the read failed.
 */

type Added = {
	state: string;
	source: string;
	readStatus: "reading" | "failed" | null;
	readError: string | null;
	runStatus: string | null;
	filterDecision: string | null;
};

export type AddedStep =
	| "queued"
	| "reading"
	| "checking"
	| "scoring"
	| "failed";

/** Where a job added by link is: null once it has a result (or for any other job). */
export function addedStep(job: Added): AddedStep | null {
	if (job.source !== "manual") return null;
	if (job.readStatus === "failed") return "failed";
	if (job.readStatus === "reading")
		return job.runStatus === "queued" ? "queued" : "reading";
	if (job.state !== "found") return null;
	return job.filterDecision ? "scoring" : "checking";
}

export const STEP_LABEL: Record<AddedStep, string> = {
	queued: "Waiting to read…",
	reading: "Reading posting…",
	checking: "Checking your job search…",
	scoring: "Scoring fit…",
	failed: "Couldn't read the posting",
};

/** The link's site, for a row whose posting has not been read: "careers.example.com". */
export function linkHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Opens the add dialog in paste mode for a job already here (from a row or the detail). */
export type PasteFor = {
	applicationId: string;
	url: string;
	title?: string;
	description?: string;
};
export const PASTE_FOR_EVENT = "offerfinch:paste-for";
function openPasteFor(detail: PasteFor) {
	window.dispatchEvent(new CustomEvent(PASTE_FOR_EVENT, { detail }));
}

/** Retry, Paste description, Remove: for a job whose posting could not be read. */
export function AddedActions({
	job,
	size = "xs",
}: {
	job: PasteFor;
	size?: "xs" | "sm";
}) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: orpc.inbox.key() });
		void queryClient.invalidateQueries({ queryKey: ["inbox"] });
		void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
	};
	const retry = useMutation({
		mutationFn: () => client.jobs.retryRead({ id: job.applicationId }),
		onSuccess: refresh,
		onError: (error) => toast.error(error.message),
	});
	const remove = useMutation({
		mutationFn: () => client.jobs.remove({ id: job.applicationId }),
		onSuccess: () => {
			toast.success("Removed.");
			refresh();
			router.push("/inbox?view=all");
		},
		onError: (error) => toast.error(error.message),
	});
	const busy = retry.isPending || remove.isPending;
	// Buttons inside a list row must not select the row.
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();
	return (
		<fieldset
			className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
			onClick={stop}
			onKeyDown={stop}
			aria-label="What to do"
		>
			<Button
				size={size}
				variant="outline"
				disabled={busy}
				onClick={() => retry.mutate()}
				data-testid="added-retry"
			>
				<RotateCw />
				Retry
			</Button>
			<Button
				size={size}
				variant="outline"
				disabled={busy}
				onClick={() => openPasteFor(job)}
				data-testid="added-paste"
			>
				Paste description
			</Button>
			<Button
				size={size}
				variant="ghost"
				disabled={busy}
				onClick={() => remove.mutate()}
				data-testid="added-remove"
			>
				<Trash2 />
				Remove
			</Button>
		</fieldset>
	);
}

const STEPS: AddedStep[] = ["reading", "checking", "scoring"];

/**
 * The detail pane while a job added by link is in progress: the three steps, the current one
 * turning, and a calm placeholder where the posting will be. On failure: the cause and actions.
 */
export function AddedProgress({
	step,
	job,
	readError,
}: {
	step: AddedStep;
	job: PasteFor;
	readError: string | null;
}) {
	if (step === "failed")
		return (
			<div
				className="mx-auto flex w-full max-w-192 flex-col gap-3 px-6 py-6"
				data-testid="added-failed"
			>
				<h3 className="text-foreground text-sm font-semibold">
					The posting couldn't be read
				</h3>
				<p className="text-muted-foreground text-sm">
					{readError ?? "The page could not be read."} Try again, paste the
					posting's text, or remove the job.
				</p>
				<AddedActions job={job} size="sm" />
			</div>
		);
	const current = step === "queued" ? 0 : STEPS.indexOf(step);
	return (
		<div
			className="mx-auto flex w-full max-w-192 flex-col gap-6 px-6 py-6"
			data-testid="added-progress"
			data-step={step}
			role="status"
		>
			<ol className="flex flex-col gap-2 text-sm">
				{STEPS.map((s, i) => (
					<li key={s} className="flex items-center gap-2">
						<span className="flex size-4 items-center justify-center">
							{i < current ? (
								<Check className="text-brand size-3.5" aria-hidden />
							) : i === current ? (
								<LoaderCircle
									className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
									aria-hidden
								/>
							) : (
								<span className="bg-border size-1.5 rounded-full" />
							)}
						</span>
						<span
							className={
								i === current ? "text-foreground" : "text-muted-foreground"
							}
						>
							{i === 0 && step === "queued"
								? STEP_LABEL.queued
								: STEP_LABEL[s].replace("…", i < current ? "" : "…")}
						</span>
					</li>
				))}
			</ol>
			<div className="flex flex-col gap-2.5" aria-hidden>
				<Skeleton className="h-4 w-2/5" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-11/12" />
				<Skeleton className="h-3 w-4/5" />
				<Skeleton className="mt-3 h-4 w-1/3" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-3/4" />
			</div>
			<p className="text-muted-foreground text-xs">
				You can close this or quit the app; it carries on where it left off.
			</p>
		</div>
	);
}
