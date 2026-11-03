import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import type { ReactNode } from "react";
import type { AppDetail } from "@/components/pipeline/application/types";
import { ErrorLine } from "@/components/system/bits";
import { ReadingColumn, ReadingPage } from "@/components/system/document";
import { Button } from "@/components/ui/button";
import { orpc } from "@/lib/orpc";
import { ApplicationReading, type DocumentContext } from "./document-tabs";
import type { OlderVersion } from "./version-picker";

/** An earlier version, read only, with the way back to the current one. */
function EarlierVersion({
	app,
	older,
	bar,
	onBack,
}: {
	app: AppDetail;
	older: OlderVersion;
	bar: ReactNode;
	onBack: () => void;
}) {
	const query = useQuery(
		orpc.application.documentVersion.queryOptions({
			input: { id: app.id, kind: older.kind, version: older.version },
		}),
	);
	const current = app.documents.find((d) => d.kind === older.kind)?.version;
	const doc = query.data;
	return (
		<ReadingColumn bar={bar}>
			<div
				className="border-border bg-card text-foreground mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
				data-testid="earlier-version"
			>
				<History className="text-muted-foreground size-4 shrink-0" />
				<span className="min-w-0 flex-1">
					Version {older.version}, read only. Only the current version,{" "}
					{current}, is checked and can be approved.
				</span>
				<Button size="sm" variant="outline" onClick={onBack}>
					Back to version {current}
				</Button>
			</div>
			{query.isError ? (
				<ErrorLine>
					Could not open this version: {query.error.message}
				</ErrorLine>
			) : !doc ? null : doc.html !== null ? (
				<ReadingPage
					html={doc.html}
					data-testid={`doc-${older.kind}-v${older.version}`}
				/>
			) : (
				<ReadingPage data-testid={`doc-${older.kind}-v${older.version}`}>
					{doc.formAnswers.map((a) => (
						<div key={a.question} className="mb-4">
							<p>
								<strong>{a.question}</strong>
							</p>
							<p className="whitespace-pre-wrap">{a.answer}</p>
						</div>
					))}
					{doc.formAnswers.length === 0 && <p>No form answers.</p>}
				</ReadingPage>
			)}
		</ReadingColumn>
	);
}

/** The reading column: the current document, or an earlier version picked to read. */
export function DocumentReading(
	props: DocumentContext & { docBar: ReactNode },
) {
	const { older, loaded, tab, editing, setOlder, docBar } = props;
	if (older?.appId === loaded.id && older.kind === tab && editing !== tab)
		return (
			<EarlierVersion
				app={loaded}
				older={older}
				bar={docBar}
				onBack={() => setOlder(null)}
			/>
		);
	return <ApplicationReading {...props} />;
}
