// Refuses to drive a build that could reach the user's real data: one that does not read
// OFFERFINCH_USER_DATA, or lacks the automation guard (main exits under a debugger or a remote
// debugging port without that folder). Builds before both used the default folder, where an
// installed copy's single-instance lock brings its window forward.
import fs from "node:fs";
import path from "node:path";

export function assertSafeBuild(appPath) {
	const asar = path.join(appPath, "Contents/Resources/app.asar");
	const bytes = fs.existsSync(asar) ? fs.readFileSync(asar) : Buffer.alloc(0);
	const has = (text) => bytes.includes(Buffer.from(text));
	if (!has("OFFERFINCH_USER_DATA") || !has("needs OFFERFINCH_USER_DATA"))
		throw new Error(
			`Refusing to launch ${appPath}: it does not read OFFERFINCH_USER_DATA or lacks the automation guard, so it could use the real data folder.`,
		);
}
