// Locate the pinned npm CLI's native binary for the macOS boundary tests. A shell/Node
// launcher cannot run inside the production sandbox, which only allows the binary directory.
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
	throw new Error("Codex boundary tests require macOS arm64 or x64");
const require = createRequire(
	realpathSync(path.resolve(process.argv[2], "@openai/codex/package.json")),
);
const platformPackage = require.resolve(
	`@openai/codex-darwin-${process.arch}/package.json`,
);
const target = process.arch === "arm64" ? "aarch64" : "x86_64";
const bin = path.join(
	path.dirname(platformPackage),
	"vendor",
	`${target}-apple-darwin`,
	"bin",
);
accessSync(path.join(bin, "codex"), constants.X_OK);
console.log(bin);
