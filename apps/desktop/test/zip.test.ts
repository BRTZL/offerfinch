import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createZipTools,
	isSafeZipEntry,
	windowsTarPath,
} from "../src/main/zip";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "of-zip-"));
	temps.push(temp);
	const source = path.join(temp, "backup source");
	fs.mkdirSync(path.join(source, "files", "documents"), { recursive: true });
	fs.writeFileSync(path.join(source, "manifest.json"), "{}");
	fs.writeFileSync(
		path.join(source, "files", "documents", "Lebenslauf Müller.pdf"),
		"unicode fixture",
	);
	fs.writeFileSync(path.join(source, "offerfinch.sqlite"), "fixture database");
	fs.writeFileSync(path.join(source, "files", "documents", "cv.txt"), "sample");
	const out = path.join(temp, "out");
	fs.mkdirSync(out);
	return { source, out, zip: path.join(temp, "backup.zip.partial") };
}
function expectLayout(out: string) {
	expect(
		fs.readFileSync(
			path.join(out, "files", "documents", "Lebenslauf Müller.pdf"),
			"utf8",
		),
	).toBe("unicode fixture");
	expect(fs.readdirSync(out).sort()).toEqual([
		"files",
		"manifest.json",
		"offerfinch.sqlite",
	]);
	expect(
		fs.readFileSync(path.join(out, "files", "documents", "cv.txt"), "utf8"),
	).toBe("sample");
	expect(fs.readFileSync(path.join(out, "offerfinch.sqlite"), "utf8")).toBe(
		"fixture database",
	);
}
const tar = createZipTools({
	platform: "win32",
	tar: process.platform === "darwin" ? "/usr/bin/tar" : windowsTarPath(),
});
const ditto = createZipTools({ platform: "darwin" });

describe("zip paths", () => {
	it("uses System32 rather than PATH, with Windows directory fallbacks", () => {
		expect(
			windowsTarPath({ SystemRoot: "D:\\Windows", WINDIR: "E:\\Windows" }),
		).toBe("D:\\Windows\\System32\\tar.exe");
		expect(windowsTarPath({ WINDIR: "E:\\Windows" })).toBe(
			"E:\\Windows\\System32\\tar.exe",
		);
		expect(windowsTarPath({})).toBe("C:\\Windows\\System32\\tar.exe");
	});
	it.each([
		"C:\\x",
		"C:x",
		"\\\\server\\share\\x",
		"\\x",
		"/x",
		"a/../../x",
		"a\\..\\x",
		"a/.. /x",
		"a/.../x",
		"a/.. ./x",
	])("rejects %j on every host", (name) => {
		expect(isSafeZipEntry(name)).toBe(false);
	});
	it.each(["manifest.json", "./files/", "files/documents/cv.txt"])(
		"accepts %j",
		(name) => {
			expect(isSafeZipEntry(name)).toBe(true);
		},
	);
});

describe.skipIf(!["darwin", "win32"].includes(process.platform))(
	"bsdtar zip operations",
	() => {
		it("writes an actual zip to .partial and round-trips the backup root", async () => {
			const { source, out, zip } = fixture();
			await tar.create(source, zip);
			expect(fs.readFileSync(zip).subarray(0, 2).toString()).toBe("PK");
			expect(await tar.list(zip)).toContain("./manifest.json");
			await tar.extract(zip, out);
			expectLayout(out);
		});
		it("keeps the diagnostics parent folder", async () => {
			const { source, out, zip } = fixture();
			await tar.create(source, zip, true);
			expect(await tar.list(zip)).toContain("backup source/manifest.json");
			await tar.extract(zip, out);
			expect(fs.readdirSync(out)).toEqual(["backup source"]);
			expectLayout(path.join(out, "backup source"));
		});
		it("refuses unsafe entries before extracting any files", async () => {
			const { source, out, zip } = fixture();
			await tar.create(source, zip);
			const tools = { ...tar, list: async () => ["manifest.json", "C:\\x"] };
			await expect(tools.extract(zip, out)).rejects.toThrow(
				"Unsafe path in zip",
			);
			expect(fs.readdirSync(out)).toEqual([]);
		});
	},
);

describe.skipIf(process.platform !== "darwin")(
	"ditto and bsdtar compatibility",
	() => {
		it("extracts a ditto backup with tar", async () => {
			const { source, out, zip } = fixture();
			await ditto.create(source, zip);
			await tar.extract(zip, out);
			expectLayout(out);
		});
		it("extracts a tar .partial zip with ditto", async () => {
			const { source, out, zip } = fixture();
			await tar.create(source, zip);
			await ditto.extract(zip, out);
			expectLayout(out);
		});
	},
);
