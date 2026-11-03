import fs from "node:fs";
import path from "node:path";
import { app, dialog, shell } from "electron";
import { mainState, TEST_MODE } from "./state";
import { testHooks } from "./test-hooks";

/**
 * Add to Calendar on an interview stage: the worker builds the .ics (never with the user's
 * notes), the user picks where to save it, and Calendar opens it and asks which calendar to add
 * it to. No calendar permission, no network. Returns the saved file's name, or null if cancelled.
 */
export async function saveInterviewEvent(
	stageId: unknown,
): Promise<string | null> {
	if (typeof stageId !== "string") throw new Error("Bad id");
	const file = await mainState.worker.request<{ name: string; text: string }>(
		"interviewEvent",
		stageId,
	);
	// Test runs: no dialog to answer and no Calendar to open; the file goes beside the data.
	if (TEST_MODE) {
		const dir = path.join(app.getPath("userData"), "saved");
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(path.join(dir, file.name), file.text);
		testHooks.savedFiles.push(path.join(dir, file.name));
		return file.name;
	}
	const target = await dialog.showSaveDialog({
		defaultPath: path.join(app.getPath("downloads"), file.name),
		filters: [{ name: "Calendar event", extensions: ["ics"] }],
	});
	if (target.canceled || !target.filePath) return null;
	await fs.promises.writeFile(target.filePath, file.text);
	const opened = await shell.openPath(target.filePath);
	if (opened) throw new Error(`Saved, but Calendar did not open it: ${opened}`);
	return path.basename(target.filePath);
}
