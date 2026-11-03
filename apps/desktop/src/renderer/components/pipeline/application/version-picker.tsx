import type { AppDetail, Kind } from "@/components/pipeline/application/types";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

/** An earlier version picked for reading: which application, document and version. */
export type OlderVersion = { appId: string; kind: Kind; version: number };

type Version = AppDetail["versions"][number];

function versionLabel(v: Version, current: number): string {
	const how =
		v.createdBy === "user" ? ", edited by you" : v.redraft ? ", redrafted" : "";
	return `Version ${v.version}${how}${v.version === current ? "" : " (earlier)"}`;
}

/**
 * The document's version: plain text while there is one, a picker once there are more. An
 * earlier version opens read only; the current one is what is checked and approved.
 */
export function VersionPicker({
	app,
	kind,
	current,
	older,
	setOlder,
}: {
	app: AppDetail;
	kind: Kind;
	current: { version: number; createdBy: string };
	older: OlderVersion | null;
	setOlder: (next: OlderVersion | null) => void;
}) {
	const versions = app.versions
		.filter((v) => v.kind === kind)
		.sort((a, b) => b.version - a.version);
	const plain = `Version ${current.version}${current.createdBy === "user" ? ", edited by you" : ""}`;
	if (versions.length < 2)
		return (
			<span className="text-muted-foreground ml-auto text-xs tabular-nums">
				{plain}
			</span>
		);
	const shown =
		older && older.appId === app.id && older.kind === kind
			? older.version
			: current.version;
	const items = versions.map((v) => ({
		value: String(v.version),
		label: versionLabel(v, current.version),
	}));
	return (
		<Select
			value={String(shown)}
			items={items}
			onValueChange={(next) => {
				const version = Number(next);
				setOlder(
					version && version !== current.version
						? { appId: app.id, kind, version }
						: null,
				);
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label="Version"
				className="text-muted-foreground ml-auto min-w-0 border-transparent bg-transparent text-xs tabular-nums shadow-none"
				data-testid="version-picker"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="end" alignItemWithTrigger={false}>
				{items.map((item) => (
					<SelectItem
						key={item.value}
						value={item.value}
						data-testid={`version-${item.value}`}
					>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
