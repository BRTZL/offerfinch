/**
 * Which Inbox rows the user has read, kept in localStorage as the unread dot always was. A row
 * is read once it has been open for READ_AFTER_MS; leaving it sooner keeps it unread. Rows that
 * existed when this was first used (the upgrade) count as read, so nobody opens the app to a
 * wall of dots. No imports from the app: unit-tested in node with fake timers.
 */

/** How long a row stays open before it counts as read. */
export const READ_AFTER_MS = 5_000;

/** The ids opened, newest last (the key the dot has always used). */
const SEEN_KEY = "offerfinch.inbox.seen";
/** When read state began: rows created before it count as read. */
const SINCE_KEY = "offerfinch.inbox.readSince";
/** Enough for years of scans; the oldest ids drop first. */
const KEEP = 5_000;

type Store = Pick<Storage, "getItem" | "setItem">;

interface ReadRow {
	id: string;
	createdAt: Date | string | number;
}

interface ReadState {
	isUnread: (row: ReadRow) => boolean;
	markRead: (id: string) => void;
}

export function createReadState(
	storage: Store,
	now: () => number = Date.now,
): ReadState {
	let since = Number(storage.getItem(SINCE_KEY));
	if (!Number.isFinite(since) || since <= 0) {
		since = now();
		try {
			storage.setItem(SINCE_KEY, String(since));
		} catch {}
	}
	let seen: string[];
	try {
		const parsed = JSON.parse(storage.getItem(SEEN_KEY) ?? "[]");
		seen = Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		seen = [];
	}
	const set = new Set(seen);
	return {
		isUnread: (row) =>
			!set.has(row.id) && new Date(row.createdAt).getTime() > since,
		markRead: (id) => {
			if (set.has(id)) return;
			set.add(id);
			seen = [...seen, id].slice(-KEEP);
			try {
				storage.setItem(SEEN_KEY, JSON.stringify(seen));
			} catch {}
		},
	};
}

/**
 * Marks `id` read after it has stayed open for `delay`; the returned function cancels it (the
 * user moved on first).
 */
export function readAfterDelay(
	id: string,
	state: ReadState,
	onRead: (id: string) => void,
	delay = READ_AFTER_MS,
): () => void {
	const timer = setTimeout(() => {
		state.markRead(id);
		onRead(id);
	}, delay);
	return () => clearTimeout(timer);
}
