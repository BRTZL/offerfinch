import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Markdown } from "@/components/system/markdown";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useCommand } from "@/lib/commands";
import { desktop } from "@/lib/desktop";
import { client } from "@/lib/orpc";
import {
	notesUpTo,
	parseChangelog,
	type ReleaseSection,
	whatsNew,
} from "../../../shared/release-notes";

/**
 * What's new (issue #9): once after the app starts on a new version, the release notes bundled
 * with it; and any time from Settings › General. Closing the sheet stores the version as seen,
 * so it does not come back. A first run stores it without showing anything, and onboarding is
 * never covered by it.
 */
export function WhatsNewHost() {
	const [location] = useLocation();
	const onboarding = location.startsWith("/onboarding");
	const [shown, setShown] = useState<{
		version: string;
		sections: ReleaseSection[];
	} | null>(null);
	const checked = useRef(false);

	// Runs during onboarding too: a first run must store its version at once, or finishing
	// onboarding would later read as an upgrade. Notes wait until onboarding is left.
	useEffect(() => {
		if (checked.current) return;
		checked.current = true;
		void (async () => {
			const [notes, state] = await Promise.all([
				desktop.releaseNotes(),
				client.whatsNew.state(),
			]);
			const decision = whatsNew({
				version: notes.version,
				seen: state.seen,
				usedBefore: state.usedBefore,
				sections: parseChangelog(notes.changelog),
			});
			if (decision.kind === "record")
				await client.whatsNew.seen({ version: notes.version });
			if (decision.kind !== "show") return;
			if (onboarding) checked.current = false;
			else setShown({ version: notes.version, sections: decision.sections });
		})().catch(() => {
			// Release notes are a courtesy: a failure here must never get in the way.
			checked.current = false;
		});
	}, [onboarding]);

	const showAll = useCallback(() => {
		void desktop.releaseNotes().then((notes) =>
			setShown({
				version: notes.version,
				sections: notesUpTo(notes.version, parseChangelog(notes.changelog)),
			}),
		);
	}, []);
	useCommand("whats-new", showAll);

	const close = () => {
		if (shown) void client.whatsNew.seen({ version: shown.version });
		setShown(null);
	};
	return (
		<Dialog open={shown !== null} onOpenChange={(open) => !open && close()}>
			<DialogContent data-testid="whats-new-sheet" className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>What's new in OfferFinch</DialogTitle>
					<DialogDescription>
						{shown ? `You're on version ${shown.version}.` : ""}
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-6">
					{shown?.sections.length ? (
						shown.sections.map((s) => (
							<section key={s.version} data-testid="whats-new-section">
								<h3 className="text-muted-foreground mb-2 text-xs font-semibold">
									{s.version === "Unreleased"
										? "Coming in the next version"
										: `Version ${s.version}${s.date ? ` · ${s.date}` : ""}`}
								</h3>
								<Markdown text={s.body} />
							</section>
						))
					) : (
						<p className="text-muted-foreground text-sm">
							No release notes came with this version.
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<DialogClose variant="default" data-testid="whats-new-done">
						Done
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
