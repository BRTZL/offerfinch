import { type ReactNode, useState } from "react";
import {
	ApplicationDetail,
	ToolbarSlot,
} from "@/components/pipeline/application/detail";
import { EmptyState, ErrorLine } from "@/components/system/bits";
import { PageHeader } from "@/components/system/layout";
import { ListRowsSkeleton, SelectableList } from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { useParams, useRouter } from "@/lib/router";

/**
 * A list of applications beside the one chosen, at `/<base>/:id`: Applied and Rejected, laid out
 * as the Inbox is (same rows, keys, detail and empty state).
 */
export function ApplicationListPage<T extends { id: string; state: string }>({
	base,
	title,
	subtitle,
	toolbar,
	items,
	loading,
	error,
	empty,
	render,
	label,
}: {
	base: string;
	title: string;
	subtitle?: string;
	toolbar?: ReactNode;
	items: T[];
	loading: boolean;
	error: string | null;
	empty: { icon: ReactNode; title: string; body: ReactNode };
	render: Parameters<typeof SelectableList<T>>[0]["render"];
	label: string;
}) {
	const router = useRouter();
	const { id: selectedId } = useParams<{ id?: string }>();
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	const selected = items.find((i) => i.id === selectedId);
	return (
		<ToolbarSlot.Provider value={slot}>
			<PageHeader title={title} subtitle={subtitle}>
				{toolbar}
				<div ref={setSlot} className="flex items-center gap-1" />
			</PageHeader>
			<MasterDetail
				list={
					error ? (
						<div className="px-4 py-3">
							<ErrorLine>{error}</ErrorLine>
						</div>
					) : loading ? (
						<ListRowsSkeleton rows={6} />
					) : items.length === 0 ? (
						<EmptyState icon={empty.icon} title={empty.title}>
							{empty.body}
						</EmptyState>
					) : (
						<SelectableList
							items={items}
							selectedId={selectedId}
							onSelect={(id) => router.replace(`${base}/${id}`)}
							label={label}
							render={render}
							detailId="application-detail"
						/>
					)
				}
			>
				<div className="flex min-h-0 min-w-0 flex-1">
					{selectedId ? (
						<ApplicationDetail
							key={selectedId}
							id={selectedId}
							listState={selected?.state}
							rejectRequest={0}
						/>
					) : (
						<div className="flex flex-1 items-center justify-center">
							<EmptyState icon={empty.icon} title="Nothing selected">
								{items.length > 0
									? "Choose one in the list, or press ↓ there."
									: empty.body}
							</EmptyState>
						</div>
					)}
				</div>
			</MasterDetail>
		</ToolbarSlot.Provider>
	);
}
