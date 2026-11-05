/** Browser-safe platform detection; defaults to macOS for existing Node callers. */
export function isMacPlatform(platform: string): boolean {
	return /mac|darwin/i.test(platform);
}

export const IS_MAC =
	typeof navigator === "undefined"
		? typeof process === "undefined" || process.platform === "darwin"
		: isMacPlatform(navigator.platform);

export function primaryModifier(
	event: { metaKey: boolean; ctrlKey: boolean },
	isMac = IS_MAC,
): boolean {
	return isMac ? event.metaKey : event.ctrlKey;
}
