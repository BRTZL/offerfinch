import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MessageSquareText, X } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	type ChatMessage,
	ProposalCard,
} from "@/components/pipeline/chat/proposal-card";
import { EmptyState, ErrorLine, Notice } from "@/components/system/bits";
import { DocumentPage } from "@/components/system/document";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client, orpc } from "@/lib/orpc";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

export type ChatTarget =
	| { scope: "application"; applicationId: string }
	| { scope: "profile" };

/**
 * The chat beside an application or the profile: one component for both. Messages, the model's
 * suggestions as cards to accept or dismiss, a composer (Enter sends, Shift+Enter breaks the
 * line). A reply is written in the worker; the thread is polled while it works, so leaving and
 * coming back shows where it is.
 */
export function ChatPanel({
	target,
	title = "Chat",
	examples,
	intro,
	editable = true,
	onClose,
	className,
	style,
	children,
}: {
	target: ChatTarget;
	title?: string;
	/** Three prompts the empty chat offers. */
	examples: string[];
	/** The empty chat's one line. */
	intro: string;
	/** Whether document edits can be accepted now. */
	editable?: boolean;
	onClose: () => void;
	className?: string;
	style?: CSSProperties;
	/** The resize handle. */
	children?: ReactNode;
}) {
	const queryClient = useQueryClient();
	const thread = useQuery({
		...orpc.chat.thread.queryOptions({ input: target }),
		refetchInterval: (q) => (q.state.data?.working ? 1_000 : false),
	});
	const [text, setText] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const [atBottom, setAtBottom] = useState(true);
	const messages = thread.data?.messages ?? [];
	const working = thread.data?.working ?? false;

	// A reply that just landed may have changed what other screens show (nothing is applied
	// until Accept, but the thread list and costs move).
	const wasWorking = useRef(working);
	useEffect(() => {
		if (wasWorking.current && !working)
			void queryClient.invalidateQueries({ queryKey: orpc.application.key() });
		wasWorking.current = working;
	}, [working, queryClient]);

	const send = useMutation({
		mutationFn: (message: string) =>
			client.chat.send({ ...target, text: message }),
		onSuccess: () => {
			setText("");
			setAtBottom(true);
			void queryClient.invalidateQueries({ queryKey: orpc.chat.key() });
		},
		onError: (error) => toast.error(error.message.replace(/^Refusing: /, "")),
	});
	const submit = (message: string) => {
		const trimmed = message.trim();
		if (!trimmed || working || send.isPending) return;
		send.mutate(trimmed);
	};

	// Follow the conversation while the user is at its end; leave them where they read otherwise.
	const last = messages.at(-1);
	const tick = `${messages.length}:${last?.status}:${last?.proposals.map((p) => p.status).join()}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the content that changed
	useLayoutEffect(() => {
		const el = listRef.current;
		if (el && atBottom) el.scrollTop = el.scrollHeight;
	}, [tick, atBottom]);
	const onScroll = () => {
		const el = listRef.current;
		if (!el) return;
		setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
	};

	return (
		<aside
			aria-label={title}
			data-testid="chat-panel"
			className={cn(
				"border-border bg-background relative flex shrink-0 flex-col border-l",
				className,
			)}
			style={style}
		>
			{children}
			<div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-5">
				<h3 className="text-foreground flex-1 text-sm font-semibold">
					{title}
				</h3>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label="Close the chat"
					onClick={onClose}
				>
					<X />
				</Button>
			</div>
			<div className="relative min-h-0 flex-1">
				<div
					ref={listRef}
					onScroll={onScroll}
					className="absolute inset-0 overflow-auto px-5 pb-4"
					aria-live="polite"
					aria-busy={working}
					data-testid="chat-messages"
				>
					{thread.isError ? (
						<ErrorLine>
							Could not load the chat: {thread.error.message}
						</ErrorLine>
					) : messages.length === 0 && thread.isSuccess ? (
						<EmptyState
							icon={<MessageSquareText />}
							title="Ask for a change"
							className="px-0"
						>
							<span className="flex flex-col items-center gap-4">
								<span>{intro}</span>
								<span className="flex w-full flex-col gap-2">
									{examples.map((example) => (
										<Button
											key={example}
											size="sm"
											variant="outline"
											className="h-auto justify-start py-1.5 text-left whitespace-normal"
											onClick={() => submit(example)}
											disabled={send.isPending}
											data-testid="chat-example"
										>
											{example}
										</Button>
									))}
								</span>
							</span>
						</EmptyState>
					) : (
						<ol className="flex flex-col gap-4 pt-1">
							{messages.map((m) => (
								<Message
									key={m.id}
									message={m}
									editable={editable}
									busy={working || send.isPending}
									onRegenerate={submit}
								/>
							))}
						</ol>
					)}
				</div>
				{!atBottom ? (
					<Button
						size="icon-sm"
						variant="outline"
						className="absolute right-5 bottom-3 rounded-full"
						aria-label="Scroll to the latest message"
						onClick={() => {
							setAtBottom(true);
							const el = listRef.current;
							if (el) el.scrollTop = el.scrollHeight;
						}}
					>
						<ArrowDown />
					</Button>
				) : null}
			</div>
			<form
				className="border-border flex shrink-0 flex-col gap-1.5 border-t px-3 pt-3 pb-2"
				onSubmit={(e) => {
					e.preventDefault();
					submit(text);
				}}
			>
				<div className="relative">
					<Textarea
						aria-label="Message"
						placeholder={working ? "Writing a reply…" : "Ask for a change"}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (
								e.key === "Enter" &&
								!e.shiftKey &&
								!e.nativeEvent.isComposing
							) {
								e.preventDefault();
								submit(text);
							}
						}}
						className="max-h-40 min-h-10 pr-10"
						data-testid="chat-input"
						spellCheck
					/>
					<Button
						type="submit"
						size="icon-xs"
						className="absolute right-1.5 bottom-1.5"
						aria-label="Send"
						disabled={!text.trim() || working || send.isPending}
						data-testid="chat-send"
					>
						<ArrowUp />
					</Button>
				</div>
				<p className="text-muted-foreground text-2xs px-1">
					Enter to send, Shift+Enter for a new line. Nothing changes until you
					accept it.
				</p>
			</form>
		</aside>
	);
}

function Message({
	message,
	editable,
	busy,
	onRegenerate,
}: {
	message: ChatMessage;
	editable: boolean;
	busy: boolean;
	onRegenerate: (text: string) => void;
}) {
	if (message.role === "user")
		return (
			<li className="flex justify-end" data-testid="chat-message-user">
				<p
					className="bg-muted text-foreground max-w-4/5 rounded-xl px-3 py-2 text-sm whitespace-pre-wrap"
					data-selectable
				>
					{message.content}
				</p>
			</li>
		);
	if (message.status === "working")
		return (
			<li
				className="text-muted-foreground flex items-center gap-2 text-sm"
				data-testid="chat-working"
			>
				<span aria-hidden className="flex gap-1">
					<span className="bg-muted-foreground animate-breathe size-1.5 rounded-full" />
					<span className="bg-muted-foreground animate-breathe size-1.5 rounded-full" />
					<span className="bg-muted-foreground animate-breathe size-1.5 rounded-full" />
				</span>
				Writing a reply…
			</li>
		);
	if (message.status === "paused")
		return (
			<li data-testid="chat-paused">
				<Notice tone="warning" title="The model can't answer right now">
					{message.content}{" "}
					<Link
						href="/settings/models"
						className="text-primary hover:underline"
					>
						Open Settings › Models
					</Link>
				</Notice>
			</li>
		);
	if (message.status === "error")
		return (
			<li data-testid="chat-error">
				<Notice tone="destructive">{message.content}</Notice>
			</li>
		);
	return (
		<li className="flex flex-col gap-3" data-testid="chat-message-assistant">
			{message.html ? (
				<DocumentPage
					html={message.html}
					className="ui-prose chat-prose"
					data-selectable
				/>
			) : null}
			{message.proposals.map((p) => (
				<ProposalCard
					key={p.id}
					messageId={message.id}
					proposal={p}
					editable={editable}
					busy={busy}
					onRegenerate={onRegenerate}
				/>
			))}
		</li>
	);
}
