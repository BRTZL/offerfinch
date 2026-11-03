import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	QueryState,
	SettingsPage,
	Toggle,
} from "@/components/pipeline/settings/shared";
import { Notice } from "@/components/system/bits";
import { Group, Section } from "@/components/system/layout";
import { FormRow } from "@/components/system/rows";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { desktop } from "@/lib/desktop";
import { client, orpc } from "@/lib/orpc";
import type {
	NotificationSound,
	NotificationState,
} from "../../../shared/bridge";

const SOUNDS: { value: NotificationSound; label: string }[] = [
	{ value: "chirp", label: "Chirp" },
	{ value: "default", label: "macOS default" },
	{ value: "none", label: "None" },
];

const KINDS = [
	{
		key: "match",
		label: "New matches",
		hint: "Jobs that fit you well. One search's matches arrive as one notification.",
	},
	{
		key: "question",
		label: "Questions waiting",
		hint: "An application needs a fact your profile does not have.",
	},
	{
		key: "review",
		label: "Ready for review",
		hint: "A CV and letter are drafted and checked. Nothing is sent until you approve.",
	},
	{
		key: "stopped",
		label: "Stopped searches",
		hint: "A source asked for a person, refused, or a search failed.",
	},
	{
		key: "followup",
		label: "Follow-up reminders",
		hint: "An application you sent has had no news for 7 days. Once per stage.",
	},
] as const;

export function useNotificationState() {
	return useQuery({
		queryKey: ["desktop", "notifications"],
		queryFn: () => desktop.notifications.state(),
		refetchOnWindowFocus: true,
	});
}

/**
 * Whether notifications really reach this Mac: what the last one did, a real test, and the way
 * to fix it when macOS blocks them. Shared by onboarding and Settings.
 */
export function NotificationStatus() {
	const queryClient = useQueryClient();
	const state = useNotificationState();
	const test = useMutation({
		mutationFn: () => desktop.notifications.test(),
		onSuccess: (next) =>
			queryClient.setQueryData(["desktop", "notifications"], next),
	});
	const clear = useMutation({
		mutationFn: () => desktop.notifications.clearMissed(),
		onSuccess: (next) =>
			queryClient.setQueryData(["desktop", "notifications"], next),
	});
	const sound = useMutation({
		mutationFn: (next: NotificationSound) =>
			desktop.notifications.setSound(next),
		onSuccess: (next) =>
			queryClient.setQueryData(["desktop", "notifications"], next),
		onError: (e) => toast.error(e.message),
	});
	const s = state.data;
	const status = s?.status ?? "unknown";
	const testButton = (
		<Button
			variant={status === "delivered" ? "outline" : "default"}
			onClick={() => test.mutate()}
			disabled={test.isPending}
			data-testid="notify-test"
		>
			{test.isPending
				? "Sending…"
				: status === "unknown"
					? "Send a test notification"
					: "Send test"}
		</Button>
	);
	return (
		<div
			className="flex flex-col gap-3"
			data-testid="notify-status"
			data-status={status}
		>
			{status === "blocked" || status === "failed" ? (
				<Notice
					tone="warning"
					title="macOS is not showing OfferFinch's notifications"
					actions={
						<>
							<Button
								variant="outline"
								onClick={() => void desktop.notifications.openSettings()}
								data-testid="notify-open-settings"
							>
								Open System Settings
							</Button>
							{testButton}
						</>
					}
				>
					Turn on Allow notifications for OfferFinch in System Settings ›
					Notifications, then send a test.
				</Notice>
			) : (
				<Group>
					<FormRow
						label={
							status === "delivered"
								? "Notifications work"
								: status === "unsupported"
									? "Notifications are not available here"
									: "Not tested yet"
						}
						hint={
							status === "delivered"
								? `The last one was shown${s?.at ? ` ${new Date(s.at).toLocaleString()}` : ""}.`
								: "A real notification is sent. On its first one macOS may ask whether to allow OfferFinch."
						}
					>
						{status === "unsupported" ? null : testButton}
					</FormRow>
					<SoundRow state={s} onChange={(next) => sound.mutate(next)} />
				</Group>
			)}
			{s && s.missed > 0 ? (
				<p
					className="text-muted-foreground flex items-center gap-2 text-xs"
					data-testid="notify-missed"
				>
					{s.missed} notification{s.missed === 1 ? "" : "s"} could not be shown
					while they were blocked; what they were about is in the Inbox and
					Questions.
					<Button size="xs" variant="ghost" onClick={() => clear.mutate()}>
						Dismiss
					</Button>
				</p>
			) : null}
		</div>
	);
}

/** macOS notifications, per kind; grouped so a big scan is one notification, not forty. */
export function NotificationSettings({
	compact = false,
}: {
	compact?: boolean;
}) {
	const queryClient = useQueryClient();
	const prefs = useQuery(orpc.notifications.get.queryOptions());
	const save = useMutation({
		mutationFn: (next: NonNullable<typeof prefs.data>) =>
			client.notifications.set(next),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: orpc.notifications.key() }),
		onError: (e) => toast.error(e.message),
	});
	const body = (
		<>
			<QueryState
				isLoading={prefs.isLoading}
				error={prefs.error}
				what="notifications"
			/>
			<Section title="On this Mac">
				<NotificationStatus />
			</Section>
			{prefs.data ? (
				<Section title="Tell me about">
					<Group>
						{KINDS.map((k) => (
							<Toggle
								key={k.key}
								label={k.label}
								hint={k.hint}
								checked={prefs.data[k.key]}
								onChange={(value) =>
									save.mutate({ ...prefs.data, [k.key]: value })
								}
								testId={`notify-${k.key}`}
							/>
						))}
					</Group>
				</Section>
			) : null}
		</>
	);
	if (compact) return body;
	return (
		<SettingsPage
			id="notifications"
			title="Notifications"
			description="What OfferFinch tells you about while it runs in the menu bar."
		>
			{body}
		</SettingsPage>
	);
}

/** The notification sound: OfferFinch's chirp, macOS's default sound, or none. */
function SoundRow({
	state,
	onChange,
}: {
	state: NotificationState | undefined;
	onChange: (sound: NotificationSound) => void;
}) {
	if (!state || state.status === "unsupported") return null;
	const value = state.sound;
	return (
		<FormRow
			label="Sound"
			hint="What a notification sounds like. Try it with Send test."
		>
			<Select
				value={value}
				onValueChange={(next) => {
					if (next && next !== value) onChange(next as NotificationSound);
				}}
				items={SOUNDS}
			>
				<SelectTrigger
					aria-label="Notification sound"
					className="w-44"
					data-testid="notify-sound"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{SOUNDS.map((option) => (
						<SelectItem
							key={option.value}
							value={option.value}
							data-testid={`notify-sound-${option.value}`}
						>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FormRow>
	);
}
