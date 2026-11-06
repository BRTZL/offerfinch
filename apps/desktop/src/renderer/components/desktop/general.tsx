import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useDemoMode } from "@/components/desktop/demo";
import { SettingsPage, Toggle } from "@/components/pipeline/settings/shared";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import { sendCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import { updateLine, useUpdateState } from "@/lib/updates";

/** Launch at login, the hourly scan's pause, the browser it uses, and the version. */
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
					: "Starts in the tray when you log in, so hourly scans keep running. No window opens."
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
			description="OfferFinch lives in the tray: closing the window keeps it running and scanning every hour while your computer is awake."
		>
			<Section title="Running">
				<Group>
					{loginToggle}
					<Toggle
						label="Pause hourly scans"
						hint="Nothing is scanned until you resume. Scan now still works."
						checked={Boolean(status.data?.paused)}
						onChange={(v) => pause.mutate(v)}
						testId="pause-scans"
					/>
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
