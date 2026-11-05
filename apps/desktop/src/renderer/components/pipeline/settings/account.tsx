import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsPage } from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
import { Markdown } from "@/components/system/markdown";
import { FormRow, Row } from "@/components/system/rows";
import { RowsSkeleton } from "@/components/system/skeletons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { useRouter } from "@/lib/router";
import privacyDoc from "../../../../../../../docs/privacy.md?raw";
import uninstallDoc from "../../../../../../../docs/uninstall.md?raw";
import type { BackupSummary } from "../../../../shared/bridge";

/** Survives the reload after a restore, so the page can say it worked. */
const RESTORED_FLAG = "offerfinch:restored";

/** Everything stored on this computer for you: a backup to keep or move, a restore, the JSON export. */
export function YourDataSettings() {
	const save = useMutation({
		mutationFn: () => desktop.saveDataExport(),
		onSuccess: (saved) => {
			if (saved) toast.success("Saved your data.");
		},
		onError: (error) => toast.error(error.message),
	});
	useEffect(() => {
		if (sessionStorage.getItem(RESTORED_FLAG) !== "1") return;
		sessionStorage.removeItem(RESTORED_FLAG);
		toast.success(
			"Backup restored. A copy of your earlier data is in the backups folder.",
		);
	}, []);
	return (
		<SettingsPage
			id="your-data"
			title="Your data"
			description="Everything is stored on this computer, in the app's folder. Back it up as one file to keep it safe or move it to another computer, or download it as JSON to read. API keys and site sign-ins are never included."
		>
			<StorageSummary />
			<Section title="Backup">
				<Group data-testid="backup">
					<ExportBackup />
					<RestoreBackup />
				</Group>
			</Section>
			<Section title="Export and erase">
				<Group data-testid="your-data">
					<FormRow
						label="Download everything"
						hint="One JSON file to read or keep: profile, answers, jobs, applications, documents and their PDFs, settings, model-call costs and LinkedIn runs. It cannot be restored."
					>
						<Button
							variant="outline"
							onClick={() => save.mutate()}
							disabled={save.isPending}
							data-testid="export-link"
						>
							Download…
						</Button>
					</FormRow>
					<EraseData />
				</Group>
			</Section>
			<Section title="Privacy">
				<Group data-testid="privacy">
					<DocRow
						label="What is stored and what leaves this computer"
						hint="What OfferFinch keeps here, what it sends to the model vendors you chose and the job sites it reads, and nothing else."
						title="Privacy"
						text={privacyDoc}
						button="Read"
						testId="privacy-doc"
					/>
					<DocRow
						label="Uninstall OfferFinch"
						hint="How to remove the app and every place it keeps data, keys and sign-ins."
						title="Uninstall OfferFinch"
						text={uninstallDoc}
						button="Read"
						testId="uninstall-doc"
					/>
				</Group>
			</Section>
		</SettingsPage>
	);
}

/** A bundled document (docs/*.md), read inside the app: no web page, nothing fetched. */
function DocRow({
	label,
	hint,
	title,
	text,
	button,
	testId,
}: {
	label: string;
	hint: string;
	title: string;
	text: string;
	button: string;
	testId: string;
}) {
	const [open, setOpen] = useState(false);
	// The first heading is the dialog's title; links between the two docs are named in the text.
	const body = text.replace(/^# .*\n+/, "");
	return (
		<FormRow label={label} hint={hint}>
			<Button
				variant="outline"
				onClick={() => setOpen(true)}
				data-testid={`${testId}-open`}
			>
				{button}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent data-testid={testId}>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<Markdown text={body} />
					</DialogBody>
					<DialogFooter>
						<DialogClose>Close</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</FormRow>
	);
}

/** Saves one zip with the database and the files; keys and sign-ins stay out. */
function ExportBackup() {
	const save = useMutation({
		mutationFn: () => desktop.backup.save(),
		onSuccess: (result) => {
			if (result.status === "saved")
				toast.success(`Saved the backup as ${result.name}.`);
			else if (result.status === "failed") toast.error(result.error);
		},
		onError: (error) => toast.error(error.message),
	});
	return (
		<FormRow
			label="Export backup"
			hint="One .zip with your profile, answers, jobs, applications, documents, PDFs and settings, to keep or to restore on another computer. API keys and site sign-ins are not included: add your keys and sign in to sites again after restoring."
		>
			<Button
				variant="outline"
				onClick={() => save.mutate()}
				pending={save.isPending}
				data-testid="backup-export"
			>
				Export backup…
			</Button>
		</FormRow>
	);
}

const sizeOf = (bytes: number) =>
	bytes < 1_000_000
		? `${Math.max(1, Math.round(bytes / 1000))} KB`
		: `${(bytes / 1_000_000).toFixed(1)} MB`;

/** What a checked backup holds, so the user knows what they are about to restore. */
function BackupContents({ summary }: { summary: BackupSummary }) {
	const made = new Date(summary.createdAt);
	const rows: [string, string][] = [
		[
			"Made",
			Number.isNaN(made.getTime())
				? "Unknown"
				: made.toLocaleString(undefined, {
						dateStyle: "medium",
						timeStyle: "short",
					}),
		],
		["By OfferFinch", summary.appVersion],
		["Jobs found", String(summary.jobs)],
		["Applications", String(summary.applications)],
		["Documents", String(summary.documents)],
		["Answers and facts", String(summary.answers)],
		["Files", `${summary.files} (${sizeOf(summary.bytes)})`],
	];
	return (
		<Group data-testid="backup-contents">
			{rows.map(([label, value]) => (
				<Row
					key={label}
					title={label}
					meta={
						<span className="text-foreground" data-testid={`backup-${label}`}>
							{value}
						</span>
					}
				/>
			))}
		</Group>
	);
}

/**
 * Restore: main asks for the zip and checks it (a damaged one, or one from a newer version, is
 * refused with nothing changed), the user sees what it holds and confirms, then main saves the
 * current data to the backups folder, swaps in the backup and restarts the worker. The page
 * reloads so every screen reads the restored data.
 */
function RestoreBackup() {
	const [checked, setChecked] = useState<{
		id: string;
		summary: BackupSummary;
	} | null>(null);
	const check = useMutation({
		mutationFn: () => desktop.backup.check(),
		onSuccess: (result) => {
			if (result.status === "ready")
				setChecked({ id: result.id, summary: result.summary });
			else if (result.status === "refused") toast.error(result.error);
		},
		onError: (error) => toast.error(error.message),
	});
	const restore = useMutation({
		mutationFn: (id: string) => desktop.backup.restore(id),
		onSuccess: (result) => {
			if (result.status === "restored") {
				sessionStorage.setItem(RESTORED_FLAG, "1");
				window.location.reload();
				return;
			}
			setChecked(null);
			toast.error(result.error);
		},
		onError: (error) => {
			setChecked(null);
			toast.error(error.message);
		},
	});
	const keep = () => {
		if (checked) void desktop.backup.discard(checked.id);
		setChecked(null);
	};
	return (
		<FormRow
			label="Restore from backup"
			hint="Replaces everything here with a backup. A copy of your current data is saved in the app's backups folder first, and nothing changes if the backup cannot be read."
		>
			<Button
				variant="outline"
				onClick={() => check.mutate()}
				disabled={restore.isPending}
				pending={check.isPending}
				data-testid="backup-restore"
			>
				Restore from backup…
			</Button>
			<AlertDialog
				open={checked !== null}
				onOpenChange={(open) => {
					if (!open && !restore.isPending) keep();
				}}
			>
				<AlertDialogContent data-testid="restore-confirm-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Replace your data with this backup?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Everything here now is replaced by the backup. A copy of it is
							saved in the backups folder first. Your site sign-ins on this
							computer stay as they are.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{checked ? <BackupContents summary={checked.summary} /> : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={restore.isPending}>
							Keep my data
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => checked && restore.mutate(checked.id)}
							pending={restore.isPending}
							data-testid="restore-confirm"
						>
							Restore
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</FormRow>
	);
}

/** Erases every application, document, answer, file and setting; the app starts over. */
function EraseData() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const erase = useMutation({
		mutationFn: () => client.data.erase({ confirm: "erase" }),
		onSuccess: async () => {
			toast.success("Everything is erased.");
			await queryClient.invalidateQueries();
			router.push("/onboarding");
		},
		onError: (error) => {
			setConfirming(false);
			toast.error(error.message);
		},
	});
	return (
		<FormRow
			label="Erase everything"
			hint="Removes your profile, answers, jobs, applications, documents, files and settings from this computer. It cannot be undone."
		>
			<Button
				variant="destructive"
				onClick={() => setConfirming(true)}
				data-testid="erase-data"
			>
				Erase everything…
			</Button>
			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Erase everything for good?</AlertDialogTitle>
						<AlertDialogDescription>
							Every application, document, answer, file and setting is removed
							now. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep my data</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => erase.mutate()}
							pending={erase.isPending}
							data-testid="erase-confirm"
						>
							Erase everything
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</FormRow>
	);
}

/** What is stored on this computer, counted, and the room it takes. */
function StorageSummary() {
	const summary = useQuery(orpc.storage.summary.queryOptions());
	const d = summary.data;
	if (!d) return <RowsSkeleton rows={4} />;
	const rows: [string, string][] = [
		["Jobs found", String(d.jobs)],
		["Applications", String(d.applications)],
		["Open questions", String(d.openQuestions)],
		["Answers and facts", String(d.answers)],
		["Profile sections", String(d.profileFiles)],
		["Search preferences", d.searchPreferences > 0 ? "Saved" : "Not set"],
		["Documents and PDFs", String(d.documents)],
		[
			"On disk",
			`${sizeOf(d.databaseBytes + d.fileBytes + d.backupBytes)} (database ${sizeOf(d.databaseBytes)}, files ${sizeOf(d.fileBytes)}, backups ${sizeOf(d.backupBytes)})`,
		],
	];
	return (
		<Section title="Stored on this computer">
			<Group data-testid="storage-summary">
				{rows.map(([label, value]) => (
					<Row
						key={label}
						title={label}
						meta={<span className="text-foreground">{value}</span>}
					/>
				))}
			</Group>
		</Section>
	);
}
