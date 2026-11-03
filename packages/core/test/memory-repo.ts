import {
	ApprovalRequiredError,
	compareApproval,
	type DocumentHashes,
	hashDocuments,
} from "../src/domain/approval";
import { type ApplicationState, assertTransition } from "../src/domain/states";
import type {
	CompanyRef,
	NormalizedJob,
	SourceHealth,
} from "../src/domain/types";
import { normalizeUrl } from "../src/domain/url";
import type { FilterResult } from "../src/filter/rules";
import type { FilterSettings } from "../src/filter/settings";
import type {
	Actor,
	ApplicationRecord,
	CheckError,
	Draft,
	ExportRecord,
	PipelineRepository,
	StoredDocument,
	StoredReview,
} from "../src/pipeline/ports";
import type { ProfileSnapshot } from "../src/profile/types";
import type { FitResult } from "../src/scoring/fit";
import type { RankResult } from "../src/scoring/rank";
import type { ReviewFlag, ReviewStatus } from "../src/tailor/flags";
import type { RuleIssue } from "../src/tailor/profile-rules";
import { PERSONA_FILTER_SETTINGS } from "./helpers";

interface App {
	id: string;
	userId: string;
	jobId: string;
	state: ApplicationState;
	filter: FilterResult | null;
	fit: FitResult | null;
	endedReason: string | null;
	alertedAt: Date | null;
	workflowStarted: boolean;
	prepareAttempts?: number;
	workflowStartedAt?: Date;
	rank?: RankResult;
}

/** In-memory PipelineRepository with the same dedupe and transition rules as the Postgres one. */
export class MemoryRepo implements PipelineRepository {
	companies: (CompanyRef & {
		health: SourceHealth;
		status: "active" | "removed";
	})[] = [];
	jobs: {
		id: string;
		userId: string;
		companyId: string;
		job: NormalizedJob;
		urlKey: string;
	}[] = [];
	apps: App[] = [];
	/** Event id -> owner and application; consumed events are tracked in `consumed`. */
	events = new Map<string, { userId: string; applicationId: string }>();
	consumed = new Set<string>();
	transitions: {
		id: string;
		from: ApplicationState;
		to: ApplicationState;
		reason: string;
	}[] = [];
	settings: FilterSettings = PERSONA_FILTER_SETTINGS;
	/** Tailoring on demand: when true, a scored match waits for `requestPrepare`. */
	onDemand = false;
	prepareRequests = new Set<string>();
	requestPrepare(applicationId: string) {
		this.prepareRequests.add(applicationId);
	}
	/** Jobs the user chose anyway (Prepare anyway on a job they added). */
	chosen = new Set<string>();
	async chosenAnyway(_userId: string, applicationId: string) {
		return this.chosen.has(applicationId);
	}
	async prepareRequested(_userId: string, applicationId: string) {
		return !this.onDemand || this.prepareRequests.has(applicationId);
	}
	/** Latest version per (application, kind) wins, as in Postgres. */
	documents: {
		userId: string;
		applicationId: string;
		kind: string;
		version: number;
		content: string;
		createdBy?: Actor;
	}[] = [];
	questions: {
		id: string;
		userId: string;
		applicationId: string;
		key: string;
		question: string;
		why: string;
		status: "open" | "answered";
		answer?: string;
	}[] = [];
	reviews: (StoredReview & { userId: string; applicationId: string })[] = [];
	exports: (ExportRecord & { userId: string; applicationId: string })[] = [];
	approvals: {
		userId: string;
		applicationId: string;
		hashes: DocumentHashes;
		revoked: boolean;
	}[] = [];
	private seq = 0;

	constructor(public profile: ProfileSnapshot | null = null) {}

	private nextId(prefix: string) {
		this.seq += 1;
		return `${prefix}-${this.seq}`;
	}

	addCompany(company: Omit<CompanyRef, "id" | "userId">, userId = "u1") {
		const ref = {
			...company,
			id: this.nextId("company"),
			userId,
			health: "ok" as SourceHealth,
			status: "active" as const,
		};
		this.companies.push(ref);
		return ref;
	}

	async listActiveCompanies(userId: string, ids?: string[]) {
		return this.companies.filter(
			(c) =>
				c.userId === userId &&
				c.status === "active" &&
				(!ids || ids.includes(c.id)),
		);
	}
	private app(userId: string, applicationId: string) {
		return this.apps.find((a) => a.id === applicationId && a.userId === userId);
	}

	async setCompanyHealth(
		userId: string,
		companyId: string,
		health: SourceHealth,
	) {
		const company = this.companies.find(
			(c) => c.id === companyId && c.userId === userId,
		);
		if (company) company.health = health;
	}
	async upsertJob(userId: string, companyId: string, job: NormalizedJob) {
		if (!this.companies.some((c) => c.id === companyId && c.userId === userId))
			throw new Error(`Company ${companyId} is not owned by user ${userId}`);
		const urlKey = normalizeUrl(job.url);
		const existing = this.jobs.find(
			(j) =>
				j.userId === userId &&
				((j.job.source === job.source && j.job.externalId === job.externalId) ||
					j.urlKey === urlKey),
		);
		if (existing) return { jobId: existing.id, inserted: false };
		const id = this.nextId("job");
		this.jobs.push({ id, userId, companyId, job, urlKey });
		this.apps.push({
			id: this.nextId("app"),
			userId,
			jobId: id,
			state: "found",
			filter: null,
			fit: null,
			endedReason: null,
			alertedAt: null,
			workflowStarted: false,
		});
		return { jobId: id, inserted: true };
	}
	async listUnstartedJobIds(userId: string) {
		return this.apps
			.filter((a) => a.userId === userId && !a.workflowStarted)
			.map((a) => a.jobId);
	}
	async markWorkflowsStarted(userId: string, jobIds: string[]) {
		for (const app of this.apps)
			if (app.userId === userId && jobIds.includes(app.jobId)) {
				app.workflowStarted = true;
				app.workflowStartedAt ??= new Date();
			}
	}

	async listStuckFoundJobIds(userId: string, startedBefore: Date) {
		return this.apps
			.filter(
				(a) =>
					a.userId === userId &&
					a.state === "found" &&
					a.workflowStarted &&
					(a.workflowStartedAt ?? new Date(0)) < startedBefore,
			)
			.map((a) => a.jobId);
	}

	async getApplicationByJob(
		userId: string,
		jobId: string,
	): Promise<ApplicationRecord | null> {
		const app = this.apps.find((a) => a.jobId === jobId && a.userId === userId);
		const job = this.jobs.find((j) => j.id === jobId && j.userId === userId);
		if (!app || !job) return null;
		const company = this.companies.find(
			(c) => c.id === job.companyId && c.userId === userId,
		);
		if (!company) return null;
		return {
			applicationId: app.id,
			userId: job.userId,
			jobId,
			state: app.state,
			companyName: company.name,
			companyId: company.id,
			job: job.job,
			filter: app.filter,
			score: app.fit?.score ?? null,
			rank: app.rank?.rank ?? null,
			fit: app.fit,
			endedReason: app.endedReason,
			prepareAttempts: app.prepareAttempts ?? 0,
		};
	}
	async getFilterSettings() {
		return this.settings;
	}
	async getProfile() {
		return this.profile;
	}
	async saveFilterResult(
		userId: string,
		applicationId: string,
		result: FilterResult,
	) {
		const app = this.app(userId, applicationId);
		if (app) app.filter = result;
	}
	private async currentHashes(userId: string, applicationId: string) {
		const latest = new Map<string, { version: number; content: string }>();
		for (const d of this.documents) {
			if (d.userId !== userId || d.applicationId !== applicationId) continue;
			const seen = latest.get(d.kind);
			if (!seen || d.version > seen.version) latest.set(d.kind, d);
		}
		// The in-memory store keeps no postings: one fixed posting stands in, so approvals still
		// carry a posting hash as they do in the real stores.
		return hashDocuments(
			[...latest].map(([kind, d]) => ({ kind, content: d.content })),
			{ title: "Test role", company: "Test company", description: "" },
		);
	}
	async checkApproval(userId: string, applicationId: string) {
		const approval = this.approvals.find(
			(a) =>
				a.userId === userId && a.applicationId === applicationId && !a.revoked,
		);
		return compareApproval(
			approval?.hashes ?? null,
			await this.currentHashes(userId, applicationId),
		);
	}
	/** Test helper standing in for the dashboard's approve action. */
	async approve(userId: string, applicationId: string) {
		for (const a of this.approvals)
			if (a.applicationId === applicationId) a.revoked = true;
		this.approvals.push({
			userId,
			applicationId,
			hashes: await this.currentHashes(userId, applicationId),
			revoked: false,
		});
		return this.move(
			userId,
			applicationId,
			["ready_for_review"],
			"approved",
			"ok",
		);
	}
	private async move(
		userId: string,
		applicationId: string,
		from: readonly ApplicationState[],
		to: ApplicationState,
		reason: string,
	) {
		const app = this.app(userId, applicationId);
		if (!app || !from.includes(app.state)) return false;
		assertTransition(app.state, to);
		if (to === "applying") {
			const verdict = await this.checkApproval(userId, applicationId);
			if (!verdict.ok)
				throw new ApprovalRequiredError(applicationId, verdict.reason);
		}
		if (app.state === "approved" && to !== "applying")
			for (const a of this.approvals)
				if (a.applicationId === applicationId) a.revoked = true;
		this.transitions.push({ id: applicationId, from: app.state, to, reason });
		app.state = to;
		return true;
	}
	async recordFilterRejection(
		userId: string,
		applicationId: string,
		result: FilterResult,
	) {
		const app = this.app(userId, applicationId);
		if (app) app.filter = result;
		return this.move(
			userId,
			applicationId,
			["found"],
			"rejected_by_filter",
			result.summary,
		);
	}
	async recordScore(
		userId: string,
		applicationId: string,
		fit: FitResult,
		endedReason: string | null,
		rank?: RankResult,
	) {
		const app = this.app(userId, applicationId);
		if (app?.state !== "found") return false;
		app.fit = fit;
		app.endedReason = endedReason;
		app.rank = rank;
		return this.move(
			userId,
			applicationId,
			["found"],
			"scored",
			`score ${fit.score}`,
		);
	}
	async claimAlert(userId: string, applicationId: string) {
		const app = this.app(userId, applicationId);
		if (!app || app.alertedAt) return false;
		app.alertedAt = new Date();
		return true;
	}
	async releaseAlert(userId: string, applicationId: string) {
		const app = this.app(userId, applicationId);
		if (app) app.alertedAt = null;
	}
	async getState(userId: string, applicationId: string) {
		return this.app(userId, applicationId)?.state ?? null;
	}
	async transition(
		userId: string,
		applicationId: string,
		input: {
			from: readonly ApplicationState[];
			to: ApplicationState;
			reason: string;
		},
	) {
		return this.move(userId, applicationId, input.from, input.to, input.reason);
	}
	async saveDraft(
		userId: string,
		applicationId: string,
		draft: Draft,
		actor: Actor,
	) {
		const contents: [string, string][] = [
			["notes", draft.notes],
			["cv", draft.cv],
			["cover_letter", draft.coverLetter],
			["form_answers", JSON.stringify(draft.formAnswers)],
		];
		for (const [kind, content] of contents)
			this.addVersion(userId, applicationId, kind, content, actor);
	}
	/** Test helper standing in for a dashboard edit. */
	addVersion(
		userId: string,
		applicationId: string,
		kind: string,
		content: string,
		actor: Actor = "user",
	) {
		const version =
			Math.max(
				0,
				...this.documents
					.filter((d) => d.applicationId === applicationId && d.kind === kind)
					.map((d) => d.version),
			) + 1;
		this.documents.push({
			userId,
			applicationId,
			kind,
			version,
			content,
			createdBy: actor,
		});
		return version;
	}
	async latestDocuments(userId: string, applicationId: string) {
		const latest = new Map<string, StoredDocument>();
		for (const d of this.documents) {
			if (d.userId !== userId || d.applicationId !== applicationId) continue;
			const seen = latest.get(d.kind);
			if (!seen || d.version > seen.version)
				latest.set(d.kind, {
					kind: d.kind as StoredDocument["kind"],
					version: d.version,
					content: d.content,
					createdBy: d.createdBy ?? "workflow",
				});
		}
		return [...latest.values()];
	}
	async askQuestions(
		userId: string,
		applicationId: string,
		questions: { question: string; why: string }[],
		waitReason?: string,
	) {
		for (const q of questions) {
			const key = q.question.toLowerCase().replace(/\W+/g, " ").trim();
			if (
				this.questions.some(
					(x) => x.applicationId === applicationId && x.key === key,
				)
			)
				continue;
			this.questions.push({
				id: this.nextId("question"),
				userId,
				applicationId,
				key,
				question: q.question,
				why: q.why,
				status: "open",
			});
		}
		const open = this.questions.filter(
			(q) => q.applicationId === applicationId && q.status === "open",
		).length;
		if (waitReason && open > 0)
			await this.transition(userId, applicationId, {
				from: ["preparing"],
				to: "needs_answers",
				reason: waitReason.replace("{open}", String(open)),
			});
		return { open };
	}
	async questionHistory(userId: string, applicationId: string) {
		return {
			rounds: this.transitions.filter(
				(t) =>
					t.id === applicationId &&
					t.from === "preparing" &&
					t.to === "needs_answers",
			).length,
			asked: this.questions
				.filter((q) => q.userId === userId && q.applicationId === applicationId)
				.map((q) => ({
					question: q.question,
					answer: q.answer ?? null,
					status: q.status as "open" | "answered" | "dismissed",
				})),
		};
	}
	async recordReview(
		userId: string,
		applicationId: string,
		review: Omit<StoredReview, "id" | "atsChecked" | "createdAt">,
	) {
		const id = this.nextId("review");
		this.reviews.push({
			...review,
			id,
			userId,
			applicationId,
			atsChecked: false,
			createdAt: new Date(),
		});
		return id;
	}
	async completeReview(
		userId: string,
		reviewId: string,
		atsIssues: RuleIssue[],
		options: { flags?: ReviewFlag[]; failedStatus?: ReviewStatus } = {},
	) {
		const review = this.reviews.find(
			(r) => r.id === reviewId && r.userId === userId,
		);
		if (!review) return false;
		review.issues = [...review.issues, ...atsIssues];
		review.passed = review.passed && atsIssues.length === 0;
		review.atsChecked = true;
		if (options.flags) review.flags = options.flags;
		review.status = review.passed
			? "passed"
			: (options.failedStatus ?? "failed");
		return review.passed;
	}
	async flagReview(userId: string, reviewId: string, flags: ReviewFlag[]) {
		const review = this.reviews.find(
			(r) => r.id === reviewId && r.userId === userId,
		);
		if (!review) return;
		review.flags = flags;
		review.status = "claims_flagged";
	}
	async latestReview(userId: string, applicationId: string) {
		return (
			this.reviews.findLast(
				(r) => r.userId === userId && r.applicationId === applicationId,
			) ?? null
		);
	}
	async saveExport(
		userId: string,
		applicationId: string,
		record: ExportRecord,
	) {
		this.exports.push({ ...record, userId, applicationId });
	}
	checkErrors = new Map<string, CheckError | null>();
	async setCheckError(
		_userId: string,
		applicationId: string,
		error: CheckError | null,
	): Promise<void> {
		this.checkErrors.set(applicationId, error);
	}

	async setPrepareAttempts(
		userId: string,
		applicationId: string,
		attempts: number,
	) {
		const app = this.app(userId, applicationId);
		if (app) app.prepareAttempts = attempts;
	}

	/** Test helper standing in for the dashboard's recordUserAction. */
	addEvent(eventId: string, userId: string, applicationId: string) {
		this.events.set(eventId, { userId, applicationId });
	}
	async consumeEvent(userId: string, applicationId: string, eventId: string) {
		const event = this.events.get(eventId);
		if (
			!event ||
			event.userId !== userId ||
			event.applicationId !== applicationId ||
			this.consumed.has(eventId)
		)
			return false;
		this.consumed.add(eventId);
		return true;
	}
}
