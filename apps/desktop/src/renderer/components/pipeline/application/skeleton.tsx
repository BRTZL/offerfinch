import { DocumentWell } from "@/components/system/document";
import { LoadingShape } from "@/components/system/loading";
import { SplitPanes } from "@/components/system/master-detail";

/**
 * The detail before it loads: a sample application laid out like the real one and drawn as
 * bones by Skullet, so the panes keep their place when it lands.
 */
export function DetailSkeleton() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<LoadingShape label="Loading the application">
				<div className="border-border flex flex-col gap-3 border-b px-5 py-4">
					<h2 className="text-xl font-semibold">Senior Frontend Engineer</h2>
					<p className="text-sm">Nimbus Labs · Hybrid · Lisbon · Greenhouse</p>
				</div>
			</LoadingShape>
			<SplitPanes
				start={
					<LoadingShape>
						<div className="flex flex-col gap-3 px-5 py-4 text-sm">
							<p className="font-semibold">Posting</p>
							<p>
								Nimbus Labs builds scheduling software used by four thousand
								clinics. We are hiring a frontend engineer.
							</p>
							<p>Build and document components in React and TypeScript.</p>
							<p>Work with design on tokens, theming and dark mode.</p>
						</div>
					</LoadingShape>
				}
				end={
					<DocumentWell className="mt-10">
						<div className="doc-page">
							<LoadingShape>
								<h1>Sam Rivera</h1>
								<p>sam.rivera@example.test · Ankara</p>
								<h2>Summary</h2>
								<p>
									Frontend engineer with eight years on React and TypeScript
									products, the last four building design systems.
								</p>
								<h2>Experience</h2>
								<p>Senior Frontend Engineer, Tidewater Health</p>
							</LoadingShape>
						</div>
					</DocumentWell>
				}
			/>
		</div>
	);
}
