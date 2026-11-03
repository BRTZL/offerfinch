/**
 * Whether this process is driven by a test or debugging tool: Chromium's remote debugging (a
 * port or a pipe, as Playwright and Puppeteer use) or Node's inspector in any of its forms
 * (`--inspect`, `--inspect=9229`, `--inspect-brk`, `--inspect-brk=…`, `--inspect-wait`,
 * `--inspect-port`), on the command line or in NODE_OPTIONS. Such a run must bring its own data
 * folder (main/index.ts checks before the single-instance lock or any data is touched).
 */
const AUTOMATION =
	/^--(?:remote-debugging-(?:port|pipe)|inspect(?:-brk|-wait|-port)?)(?:=|$)/;

export function isAutomated(
	argv: readonly string[],
	nodeOptions = "",
): boolean {
	return [...argv, ...nodeOptions.split(/\s+/)].some((a) => AUTOMATION.test(a));
}
