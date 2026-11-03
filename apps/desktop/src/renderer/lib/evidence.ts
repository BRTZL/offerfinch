import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { orpc } from "@/lib/orpc";

const SECTION: Record<string, string> = {
	"personal.md": "About you",
	"summary.md": "About you",
	"skills.md": "Skills",
	"answers.md": "Answers",
};

/**
 * Names the profile record a citation points at ("Experience · Acme, Engineer") instead of its
 * file path; a record removed since shows as such.
 */
export function useEvidenceLabel(): (file: string, quote?: string) => string {
	const records = useQuery({
		...orpc.profile.records.queryOptions(),
		staleTime: 60_000,
		meta: { quiet: true },
	});
	return useCallback(
		(file: string, quote = "") => {
			if (file === "skills.md") {
				const q = quote.toLowerCase();
				const skill = records.data?.find(
					(r) =>
						r.kind === "skill" &&
						q.includes(String(r.data.name ?? "").toLowerCase()),
				);
				if (skill) return skill.label;
			}
			if (SECTION[file]) return SECTION[file];
			const record = records.data?.find((r) => r.path === file);
			if (record) return record.label;
			return records.data?.length ? "A record since removed" : file;
		},
		[records.data],
	);
}
