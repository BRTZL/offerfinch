import type { ReactNode } from "react";
import { ApplicationDetail } from "@/components/pipeline/application/detail";
import { EmptyState, ErrorLine } from "@/components/system/bits";
import { PageHeader } from "@/components/system/layout";
import {
	type ListGroup,
	ListRowsSkeleton,
	SelectableList,
} from "@/components/system/list";
import { MasterDetail } from "@/components/system/master-detail";
import { useParams, useRouter } from "@/lib/router";

/**
 * A list of applications beside the one chosen, at `/<base>/:id`: Applied and Rejected, laid out
 * as the Inbox is (same rows, keys, detail and empty state). The header holds only the title,
 * its count and the search; filters sit on top of the list (`top`).
 */
export function ApplicationListPage<T extends { id: string; state: string }>({
	base,
	title,
	subtitle,
	top,
	items,
	loading,
	error,
	empty,
	render,
	label,
	groupOf,
	groups,
}: {
	base: string;
	title: string;
	subtitle?: string;
	/** Above the list: its filter (Rejected's reasons). */
	top?: ReactNode;
	items: T[];
	loading: boolean;
	error: string | null;
	empty: { icon: ReactNode; title: string; body: ReactNode };
	render: Parameters<typeof SelectableList<T>>[0]["render"];
	label: string;
	groupOf?: (item: T) => string;
	groups?: ListGroup[];
}) {
	const router = useRouter();
	const { id: selectedId } = useParams<{ id?: string }>();
	const selected = items.find((i) => i.id === selectedId);
	return (
		<>
			<PageHeader title={title} subtitle={subtitle} />
			<MasterDetail
				list={
					<>
						{top}
						{error ? (
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
								groupOf={groupOf}
								groups={groups}
							/>
						)}
					</>
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
		</>
	);
}
