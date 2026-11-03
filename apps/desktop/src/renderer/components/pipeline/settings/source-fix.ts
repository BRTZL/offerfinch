/** A source row's one action that helps now: watch a run (or solve its check), sign in, or try again. */
export type Fix = "watch" | "sign-in" | "retry" | null;

/**
 * The action for a source's row in Settings › Sources. A sign-in wall holds the source until it
 * is cleared: Sign in while the site still asks for it, then Retry now once signed in again.
 */
export function fixFor(
	source: { signIn: boolean },
	p: { enabled: boolean; stop?: { kind: string } | null },
	tab: {
		check?: unknown;
		running?: boolean;
		signIn?: "signed-in" | "needed" | string | null;
	},
	reading: boolean,
): Fix {
	if (tab.check || tab.running || reading) return "watch";
	if (
		source.signIn &&
		(tab.signIn === "needed" ||
			(p.stop?.kind === "login_wall" && tab.signIn !== "signed-in"))
	)
		return "sign-in";
	if (p.enabled && p.stop) return "retry";
	// Signing in is offered while off too, so a source can be ready before it is turned on.
	return source.signIn && tab.signIn !== "signed-in" ? "sign-in" : null;
}
