import { useEffect, useState } from "react";
import type { UpdateState } from "../../shared/bridge";
import { desktop } from "./desktop";

/** The app's over-the-air update state, kept current from main. Null until first read. */
export function useUpdateState(): UpdateState | null {
	const [state, setState] = useState<UpdateState | null>(null);
	useEffect(() => {
		let live = true;
		desktop.updates
			.state()
			.then((s) => live && setState(s))
			.catch(() => {});
		const off = desktop.updates.onChange((s) => setState(s));
		return () => {
			live = false;
			off();
		};
	}, []);
	return state;
}

/** One line on where the update stands, for Settings. */
export function updateLine(state: UpdateState | null): string {
	if (!state) return "Checking…";
	switch (state.status) {
		case "disabled":
			return state.reason;
		case "idle":
			return "Checks GitHub for a new version every 6 hours.";
		case "checking":
			return "Checking for a new version…";
		case "up-to-date":
			return "You have the latest version.";
		case "downloading":
			return `Downloading ${state.version}… ${state.percent}%`;
		case "ready":
			return `Version ${state.version} is downloaded. Restart to update, or it installs the next time you quit.`;
		case "error":
			return `Couldn't update: ${state.error}`;
	}
}
