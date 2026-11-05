import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const shown: Record<string, unknown>[] = [];
/** macOS shows the last notification (its "show" event). */
let showLast = () => {};
let clickLast = () => {};
vi.mock("electron", () => {
	class Notification {
		constructor(options: Record<string, unknown>) {
			shown.push(options);
		}
		static isSupported() {
			return true;
		}
		on(event: string, handler: () => void) {
			if (event === "click") clickLast = handler;
		}
		once(event: string, handler: () => void) {
			if (event === "show") showLast = handler;
		}
		show() {}
	}
	return { Notification };
});

const { CHIRP_COOLDOWN_MS, CHIRP_SOUND, chirpPlayer, Notifier, soundOptions } =
	await import("../src/main/notifications");

describe("notification sound", () => {
	it("maps each choice to Electron's options: macOS plays only its own sounds", () => {
		expect(soundOptions("chirp", "darwin")).toEqual({ silent: true });
		expect(soundOptions("default", "darwin")).toEqual({});
		expect(soundOptions("none", "darwin")).toEqual({ silent: true });
	});

	it.skipIf(process.platform !== "darwin")(
		"defaults to the chirp, plays it once macOS shows the notification, and keeps the choice",
		() => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-sound-"));
			const chirp = vi.fn();
			const notifier = new Notifier(
				dir,
				() => {},
				() => {},
				false,
				chirp,
			);
			expect(notifier.get().sound).toBe("chirp");
			void notifier.show({ title: "A", body: "b", path: "/" });
			expect(shown.at(-1)).toMatchObject({ silent: true });
			expect(shown.at(-1)).not.toHaveProperty("sound");
			expect(chirp).not.toHaveBeenCalled();
			showLast();
			expect(chirp).toHaveBeenCalledTimes(1);

			notifier.setSound("none");
			void notifier.show({ title: "B", body: "c", path: "/" });
			expect(shown.at(-1)).toMatchObject({ silent: true });
			showLast();

			notifier.setSound("default");
			void notifier.show({ title: "C", body: "d", path: "/" });
			expect(shown.at(-1)).not.toHaveProperty("silent");
			showLast();
			expect(chirp).toHaveBeenCalledTimes(1);
			notifier.setSound("none");

			// Remembered across restarts.
			expect(
				new Notifier(
					dir,
					() => {},
					() => {},
				).get().sound,
			).toBe("none");
		},
	);

	it("ships the chirp in the app bundle's Resources", () => {
		const builder = fs.readFileSync(
			path.join(import.meta.dirname, "../electron-builder.yml"),
			"utf8",
		);
		expect(builder).toContain(`to: ${CHIRP_SOUND}`);
		expect(
			fs.statSync(path.join(import.meta.dirname, "../build", CHIRP_SOUND)).size,
		).toBeGreaterThan(1000);
	});
});

describe("the chirp player", () => {
	const setup = () => {
		let t = 1_000_000;
		const finish: Array<(error: Error | null) => void> = [];
		const play = chirpPlayer("chirp.aiff", () => {}, {
			platform: "darwin",
			now: () => t,
			play: (_file, done) => finish.push(done),
		});
		return {
			play,
			finish,
			advance: (ms: number) => {
				t += ms;
			},
		};
	};

	it("a burst of 100 calls starts one player", () => {
		const p = setup();
		const played = Array.from({ length: 100 }, () => p.play());
		expect(played.filter(Boolean)).toHaveLength(1);
		expect(p.finish).toHaveLength(1);
	});

	it("never two at once, even after the cooldown", () => {
		const p = setup();
		expect(p.play()).toBe(true);
		p.advance(CHIRP_COOLDOWN_MS + 1);
		// The first is still playing.
		expect(p.play()).toBe(false);
		p.finish[0]?.(null);
		expect(p.play()).toBe(true);
		expect(p.finish).toHaveLength(2);
	});

	it("waits the cooldown after a short chirp", () => {
		const p = setup();
		expect(p.play()).toBe(true);
		p.finish[0]?.(null);
		p.advance(CHIRP_COOLDOWN_MS - 1);
		expect(p.play()).toBe(false);
		p.advance(1);
		expect(p.play()).toBe(true);
	});

	it("a failed player frees it again", () => {
		const p = setup();
		p.play();
		p.finish[0]?.(new Error("afplay failed"));
		p.advance(CHIRP_COOLDOWN_MS);
		expect(p.play()).toBe(true);
	});
});

it("Windows chirp uses the system sound and never starts afplay", () => {
	expect(soundOptions("chirp", "win32")).toEqual({});
	expect(soundOptions("default", "win32")).toEqual({});
	expect(soundOptions("none", "win32")).toEqual({ silent: true });
	const play = vi.fn();
	expect(
		chirpPlayer("missing.aiff", vi.fn(), { platform: "win32", play })(),
	).toBe(false);
	expect(play).not.toHaveBeenCalled();
});

it("clicking the toast body opens its destination without action buttons", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-toast-"));
	try {
		const click = vi.fn();
		const notifier = new Notifier(dir, click, vi.fn());
		void notifier.show({ title: "Review", body: "Ready", path: "/inbox" });
		showLast();
		clickLast();
		expect(click).toHaveBeenCalledWith("/inbox");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
