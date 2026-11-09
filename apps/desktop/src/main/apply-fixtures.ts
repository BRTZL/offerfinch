/**
 * Whether this launch's submissions and form reads may use the local stand-in boards
 * (`ApplyDeps.fixtures`: 127.0.0.1 and localhost allowed, private networks not refused, local
 * forms filled without a saved read). Only an unpackaged build in test mode: a shipped app never
 * loosens these, even launched with `OFFERFINCH_TEST=1`; its test mode keeps its other effects.
 */
export function applyFixturesAllowed(launch: {
	testMode: boolean;
	isPackaged: boolean;
}): boolean {
	return launch.testMode && !launch.isPackaged;
}
