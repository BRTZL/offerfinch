import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useDemoMode } from "@/components/desktop/demo";
import { SettingsPage, Toggle } from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { sendCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { updateLine, useUpdateState } from "@/lib/updates";

type ScanSchedule = Awaited<ReturnType<typeof client.desktop.scanSchedule>>;

const EVERY: { value: string; label: string }[] = [
	{ value: "1", label: "Every hour" },
	{ value: "3", label: "Every 3 hours" },
	{ value: "6", label: "Every 6 hours" },
	{ value: "12", label: "Every 12 hours" },
	{ value: "24", label: "Every 24 hours" },
];

/**
 * Launch at login, the scan schedule (pause, interval, quiet hours), the browser it uses, and
 * the version.
 */
export function GeneralSettings({ compact = false }: { compact?: boolean }) {
	const queryClient = useQueryClient();
	const login = useQuery({
		queryKey: ["desktop", "login-item"],
		queryFn: () => desktop.loginItem.get(),
	});
	const info = useQuery({
		queryKey: ["desktop", "info"],
		queryFn: () => desktop.info(),
	});
	const status = useQuery(orpc.desktop.status.queryOptions());
	const update = useUpdateState();
	// Try-it mode checks and installs nothing (main refuses both too).
	const demo = useDemoMode();
	const check = useMutation({
		mutationFn: () => desktop.updates.check(),
		onError: (e) => toast.error(e.message),
	});
	const setLogin = useMutation({
		mutationFn: (open: boolean) => desktop.loginItem.set(open),
		onSuccess: (state) => {
			queryClient.setQueryData(["desktop", "login-item"], state);
			if (state.status === "requires-approval")
				toast.message(
					"macOS needs your approval: System Settings > General > Login Items.",
				);
		},
		onError: (e) => toast.error(e.message),
	});
	const pause = useMutation({
		mutationFn: (paused: boolean) => client.desktop.setPaused({ paused }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: orpc.desktop.key() }),
	});
	const loginToggle = (
		<Toggle
			label="Open at login"
			hint={
				login.data?.status === "requires-approval"
					? "Waiting for your approval in System Settings > General > Login Items."
					: "Starts in the tray when you log in, so scans keep running. No window opens."
			}
			checked={Boolean(login.data?.openAtLogin)}
			onChange={(v) => setLogin.mutate(v)}
			testId="login-item"
		/>
	);
	if (compact) return loginToggle;
	return (
		<SettingsPage
			id="general"
			title="General"
			description="OfferFinch lives in the tray: closing the window keeps it running and scanning on this schedule while your computer is awake."
		>
			<Section title="Running">
				<Group>
					{loginToggle}
					<Toggle
						label="Pause scans"
						hint="Nothing is scanned until you resume. Scan now still works."
						checked={Boolean(status.data?.paused)}
						onChange={(v) => pause.mutate(v)}
						testId="pause-scans"
					/>
					<ScanScheduleRows />
				</Group>
			</Section>
			<Section title="Browser">
				<Group>
					<FormRow
						label="Google Chrome"
						hint={
							<span data-testid="chrome-status">
								{status.data?.chrome
									? `Uses ${status.data.chrome} in the background for careers pages and PDFs; started only when needed.`
									: "Google Chrome was not found. Install it from google.com/chrome: careers pages and PDF export need it."}
							</span>
						}
					/>
				</Group>
			</Section>
			<Section title="About">
				<Group>
					<FormRow
						label="Updates"
						hint={<span data-testid="update-status">{updateLine(update)}</span>}
					>
						{update?.status === "ready" && !demo ? (
							<Button
								size="sm"
								data-testid="update-install"
								onClick={() => void desktop.updates.install()}
							>
								Restart to Update
							</Button>
						) : (
							<Button
								size="sm"
								variant="outline"
								data-testid="update-check"
								disabled={
									!update ||
									demo ||
									update.status === "disabled" ||
									update.status === "ready" ||
									update.status === "checking" ||
									update.status === "downloading" ||
									check.isPending
								}
								onClick={() => check.mutate()}
							>
								Check Now
							</Button>
						)}
					</FormRow>
					<FormRow
						label="What's new"
						hint="The release notes of this version and the ones before it."
					>
						<Button
							size="sm"
							variant="outline"
							data-testid="whats-new-open"
							onClick={() => sendCommand("whats-new")}
						>
							What's New
						</Button>
					</FormRow>
					<FormRow
						label="Diagnostics"
						hint="One zip of recent logs, versions and a settings summary, with personal details and keys removed, for a bug report. You see every file before saving; nothing is sent."
					>
						<Button
							size="sm"
							variant="outline"
							data-testid="diagnostics-open"
							onClick={() => sendCommand("export-diagnostics")}
						>
							Export…
						</Button>
					</FormRow>
					<FormRow
						label="Version"
						hint={
							<span className="break-all">Data: {info.data?.userData}</span>
						}
					>
						<span
							className="text-muted-foreground font-mono text-xs"
							data-testid="about-version"
						>
							OfferFinch {info.data?.version} · Electron {info.data?.electron} ·{" "}
							{info.data?.arch}
						</span>
					</FormRow>
				</Group>
			</Section>
		</SettingsPage>
	);
}

/** The scan interval and quiet hours, saved as they change (rows of Running). */
function ScanScheduleRows() {
	const queryClient = useQueryClient();
	const scheduleKey = orpc.desktop.scanSchedule.queryKey();
	const schedule = useQuery(orpc.desktop.scanSchedule.queryOptions());
	const setSchedule = useMutation({
		mutationFn: (next: ScanSchedule) => client.desktop.setScanSchedule(next),
		// Shown at once; the next scan's time (status) is read again once saved.
		onMutate: (next) => queryClient.setQueryData(scheduleKey, next),
		onSuccess: (saved) => {
			queryClient.setQueryData(scheduleKey, saved);
			void queryClient.invalidateQueries({ queryKey: orpc.desktop.key() });
		},
		onError: (e) => {
			toast.error(e.message);
			void queryClient.invalidateQueries({ queryKey: scheduleKey });
		},
	});
	const quiet = schedule.data?.quietHours;
	const saveQuiet = (patch: Partial<ScanSchedule["quietHours"]>) => {
		if (!schedule.data || !quiet) return;
		setSchedule.mutate({
			...schedule.data,
			quietHours: { ...quiet, ...patch },
		});
	};
	return (
		<>
			<FormRow
				label="Scan interval"
				hint="The next scan starts this long after the last one, Scan now included."
			>
				<Select
					value={String(schedule.data?.every ?? 1)}
					onValueChange={(next) => {
						if (next && schedule.data)
							setSchedule.mutate({
								...schedule.data,
								every: Number(next) as ScanSchedule["every"],
							});
					}}
					items={EVERY}
					disabled={!schedule.data}
				>
					<SelectTrigger
						aria-label="Scan interval"
						className="w-36"
						data-testid="scan-every"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{EVERY.map((option) => (
							<SelectItem
								key={option.value}
								value={option.value}
								data-testid={`scan-every-${option.value}`}
							>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</FormRow>
			<FormRow
				label="Quiet hours"
				hint={
					quiet?.enabled
						? "No scheduled scans or notifications in this window (your Mac's time). Notifications arrive when it ends; Scan now still works."
						: "A nightly window with no scheduled scans and no notifications."
				}
			>
				{quiet?.enabled ? (
					<>
						<Input
							type="time"
							aria-label="Quiet hours start"
							className="w-32"
							value={quiet.start}
							onChange={(e) => {
								if (e.target.value) saveQuiet({ start: e.target.value });
							}}
							data-testid="quiet-start"
						/>
						<span className="text-muted-foreground text-xs">to</span>
						<Input
							type="time"
							aria-label="Quiet hours end"
							className="w-32"
							value={quiet.end}
							onChange={(e) => {
								if (e.target.value) saveQuiet({ end: e.target.value });
							}}
							data-testid="quiet-end"
						/>
					</>
				) : null}
				<Switch
					aria-label="Quiet hours"
					checked={Boolean(quiet?.enabled)}
					onCheckedChange={(v) => saveQuiet({ enabled: v === true })}
					disabled={!quiet}
					data-testid="quiet-hours"
				/>
			</FormRow>
		</>
	);
}
