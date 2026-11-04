/**
 * A populated database as an earlier version left it, built from code: the migrations up to a
 * point, then rows of every kind the app stores, written as SQLite holds them (JSON text,
 * millisecond times, 0/1). Each row has every current column; a column or table a migration added
 * after the point is left out, so one set of rows serves every schema point. Fabricated data only.
 */
import { companyNameKey, normalizeUrl } from "@offerfinch/core/domain/url";
import { applicationInstanceId } from "@offerfinch/core/workflow/types";
import { type Database, openSqlite } from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { MIGRATIONS } from "@offerfinch/db/migrations/index";
import { APPLICATION_KIND, SCAN_KIND } from "@offerfinch/runner";

import {
	LOCAL_USER_EMAIL,
	LOCAL_USER_ID,
	SettingsStore,
} from "../../src/worker/settings";

type Row = Record<string, unknown>;
export type SettingName = Parameters<SettingsStore["get"]>[0];

const U = LOCAL_USER_ID;
const DAY = 86_400_000;
/** 2026-10-20 09:00 UTC: the fixture's "a while ago". */
const T0 = Date.UTC(2026, 9, 20, 9);
const at = (days: number) => T0 + days * DAY;
const iso = (days: number) => new Date(at(days)).toISOString();
const j = (value: unknown) => JSON.stringify(value);

/**
 * Every app setting (`SettingsStore` KEYS) at a value other than its default, the nullable ones
 * set too. Typed by the store's names: a new key does not compile until it is added here.
 * `linkedinEnabled` is the earlier versions' LinkedIn switch that the start moves and clears.
 */
export function settingsFor(latest: boolean) {
	return {
		ai: {
			scoring: {
				mode: "claude-subscription",
				model: "claude-sonnet-5-5",
				effort: "medium",
			},
			tailoring: {
				mode: "codex-subscription",
				model: "gpt-5.5",
				effort: "high",
			},
			claims: { mode: "api", model: "gpt-5.5-mini" },
		},
		notifications: {
			match: false,
			question: true,
			review: false,
			stopped: true,
			// An object stored before this switch existed reads it as on: notices.test.ts.
			followup: false,
		},
		onboarding: {
			done: ["ai", "resume", "profile", "rules"],
			skipped: ["login"],
			dismissed: true,
			completedAt: iso(1),
		},
		paused: true,
		shellPath: "/opt/fixture/bin:/usr/bin:/bin",
		linkedinEnabled: true,
		movedSearches: "An earlier note the user has not dismissed.",
		siteSessions: {
			linkedin: { signedInAt: iso(2), needsSignIn: false },
			indeed: { signedInAt: null, needsSignIn: true },
		},
		stalls: { "run-fixture-1 draft#1": 1 },
		// Older databases were filtered with version 0 (the start re-filters them once).
		jobSearchVersion: latest ? 2 : 0,
		noticeWatermark: at(5),
		whatsNewSeen: "0.0.9",
	} as const satisfies Record<SettingName, unknown>;
}

const COMPANIES: {
	id: string;
	name: string;
	source: string;
	key: string;
	extra?: Row;
}[] = [
	{
		id: "c-ashby",
		name: "Northwind Robotics",
		source: "ashby",
		key: "northwind-robotics",
	},
	{
		id: "c-greenhouse",
		name: "Brightpath Labs",
		source: "greenhouse",
		key: "brightpathlabs",
	},
	{
		id: "c-lever",
		name: "Quillstone",
		source: "lever",
		key: "quillstone",
		extra: { health: "error", health_reason: "Lever answered 503 three times" },
	},
	{
		id: "c-scrape",
		name: "Harbor & Finch GmbH",
		source: "scrape",
		key: "https://careers.harborfinch.example.com/jobs",
		extra: {
			scrape_parser: "generic",
			health: "needs_human",
			health_reason: "A check",
		},
	},
	{
		id: "c-linkedin",
		name: "Lumen Atlas",
		source: "linkedin",
		key: "lumen-atlas",
	},
	{
		id: "c-indeed",
		name: "Saltmarsh Health",
		source: "indeed",
		key: "saltmarsh-health",
	},
	{
		id: "c-glassdoor",
		name: "Tidewater Analytics",
		source: "glassdoor",
		key: "tidewater",
	},
	{
		id: "c-web",
		name: "Orchard Loop",
		source: "web",
		key: "orchardloop.example.com",
	},
	{ id: "c-manual", name: "Copperleaf", source: "manual", key: "copperleaf" },
	{
		id: "c-removed",
		name: "Gravel & Pine",
		source: "greenhouse",
		key: "gravelpine",
		extra: { status: "removed", removed_at: at(3) },
	},
];

/** One job per application state the app keeps, across every source. */
const JOBS: {
	id: string;
	company: string;
	source: string;
	title: string;
	state: string;
}[] = [
	{
		id: "j1",
		company: "c-ashby",
		source: "ashby",
		title: "Senior Frontend Engineer",
		state: "found",
	},
	{
		id: "j2",
		company: "c-greenhouse",
		source: "greenhouse",
		title: "Staff Backend Engineer",
		state: "rejected_by_filter",
	},
	{
		id: "j3",
		company: "c-lever",
		source: "lever",
		title: "Full Stack Engineer",
		state: "scored",
	},
	{
		id: "j4",
		company: "c-scrape",
		source: "scrape",
		title: "React Native Developer",
		state: "preparing",
	},
	{
		id: "j5",
		company: "c-linkedin",
		source: "linkedin",
		title: "Software Engineer, Platform",
		state: "needs_answers",
	},
	{
		id: "j6",
		company: "c-indeed",
		source: "indeed",
		title: "Frontend Developer",
		state: "ready_for_review",
	},
	{
		id: "j7",
		company: "c-glassdoor",
		source: "glassdoor",
		title: "TypeScript Engineer",
		state: "approved",
	},
	{
		id: "j8",
		company: "c-web",
		source: "web",
		title: "Product Engineer",
		state: "applied",
	},
	{
		id: "j9",
		company: "c-manual",
		source: "manual",
		title: "Mobile Engineer",
		state: "needs_human",
	},
	// Added by link and set aside by the filter: an earlier version's case the start moves back.
	{
		id: "j10",
		company: "c-manual",
		source: "manual",
		title: "Unity Developer",
		state: "rejected_by_filter",
	},
	{
		id: "j11",
		company: "c-ashby",
		source: "ashby",
		title: "Senior Software Engineer",
		state: "failed",
	},
	{
		id: "j12",
		company: "c-removed",
		source: "greenhouse",
		title: "Frontend Engineer II",
		state: "dismissed",
	},
	{
		id: "j13",
		company: "c-lever",
		source: "lever",
		title: "Backend Engineer (Node)",
		state: "rejected",
	},
	{
		id: "j14",
		company: "c-scrape",
		source: "scrape",
		title: "Web Developer",
		state: "expired",
	},
];
const ACTIVE = new Set([
	"found",
	"scored",
	"preparing",
	"needs_answers",
	"ready_for_review",
	"approved",
	"needs_human",
]);
const DRAFTED = new Set([
	"ready_for_review",
	"approved",
	"applied",
	"needs_human",
	"failed",
]);
const SCORED = new Set([
	"scored",
	"preparing",
	"needs_answers",
	...DRAFTED,
	"rejected",
	"dismissed",
	"expired",
]);

const PROFILE_FILES = [
	{
		path: "personal.md",
		content:
			"# Avery Quinn\n\n- **Email:** avery.quinn@example.com\n- **Phone:** +1 555 0100\n- **Location:** Lisbon, Portugal\n",
	},
	{
		path: "experience/2023-bluefin.md",
		content:
			"# Senior Frontend Engineer, Bluefin Labs (2023 - now)\n\n- Built Ledgerline, a TypeScript design system used by 40 engineers.\n- Cut page load time by 35% with React Server Components.\n",
	},
	{
		path: "skills.md",
		content: "# Skills\n\n- TypeScript\n- React\n- Node.js\n",
	},
];

function fitResult(score: number) {
	return {
		score,
		summary:
			"Strong frontend match; the role asks for more backend than the profile shows.",
		provider: "fake",
		droppedEvidence: [],
		requirements: [
			{
				requirement: "5+ years of TypeScript",
				importance: "must",
				status: "met",
				evidence: [
					{
						file: "experience/2023-bluefin.md",
						quote: "a TypeScript design system",
					},
				],
				note: "",
			},
			{
				requirement: "Kubernetes",
				importance: "nice",
				status: "unknown",
				evidence: [],
				note: "Not in the profile.",
			},
		],
	};
}

/** A scored application's score, fit and rank columns (null before scoring). */
function scoring(scored: boolean, i: number): Row {
	if (!scored)
		return {
			score: null,
			fit: null,
			rank: null,
			rank_penalties: null,
			scored_at: null,
			alerted_at: null,
		};
	return {
		score: 60 + i,
		fit: j(fitResult(60 + i)),
		rank: 55 + i,
		rank_penalties: j([
			{ kind: "location", points: 5, reason: "hybrid in another city" },
		]),
		scored_at: at(2),
		alerted_at: at(2),
	};
}

/** The columns a job's progress through drafting, review and submission sets. */
function progress(job: { id: string; state: string }): Row {
	const drafted = DRAFTED.has(job.state);
	const applied = job.state === "applied";
	return {
		ended_reason: ["failed", "rejected", "expired", "dismissed"].includes(
			job.state,
		)
			? `Fixture: ${job.state}`
			: null,
		chosen_anyway_at: job.id === "j3" ? at(3) : null,
		announce_ready: job.state === "ready_for_review" ? 1 : 0,
		prepare_requested_at: job.state === "preparing" ? at(3) : null,
		workflow_instance_id: applicationInstanceId(job.id),
		workflow_runtime: "local",
		workflow_started_at: at(1),
		prepare_attempts: drafted ? 1 : 0,
		check_error:
			job.state === "failed"
				? j({
						at: iso(4),
						message: "The claims check timed out",
						provider: "fake",
					})
				: null,
		current_role: drafted ? "Senior Frontend Engineer, Bluefin Labs" : null,
		// A redraft the user asked for that waits on a paused model.
		redraft:
			job.state === "ready_for_review"
				? j({
						id: "00000000-0000-4000-8000-000000000001",
						scope: "cover_letter",
						instruction: "Shorter",
						rewriteOwnAnswers: false,
						baseVersions: { cover_letter: 1 },
						requestedAt: iso(4),
						problem: {
							kind: "paused",
							message: "Fixture: spending limit reached",
							at: iso(4),
						},
					})
				: null,
		applied_at: applied ? at(6) : null,
		applied_via: applied ? "auto" : null,
		approved_at: ["approved", "applied"].includes(job.state) ? at(5) : null,
	};
}

function applicationRows(): Row[] {
	return JOBS.map((job, i) => {
		const scored = SCORED.has(job.state);
		const filtered = job.state === "rejected_by_filter";
		return {
			id: `a${i + 1}`,
			user_id: U,
			job_id: job.id,
			state: job.state,
			filter_decision: filtered ? "reject" : "keep",
			filter_result: j(
				filtered
					? {
							decision: "reject",
							reasons: ["Onsite in a country you have not chosen"],
						}
					: { decision: i % 4 === 0 ? "unclear" : "keep", reasons: [] },
			),
			flags: j(i % 4 === 0 ? ["location_unclear"] : []),
			...scoring(scored, i),
			...progress(job),
			state_changed_at: at(4),
			created_at: at(1),
			updated_at: at(4),
		};
	});
}

function jobRows(): Row[] {
	return JOBS.map((job, i) => {
		const url =
			job.source === "manual"
				? `https://careers.copperleaf.example.com/openings/${i + 100}`
				: `https://jobs.example.com/${job.source}/${job.company}/${i + 1000}`;
		return {
			id: job.id,
			user_id: U,
			company_id: job.company,
			source: job.source,
			external_id: `${job.source}-${i + 1000}`,
			url,
			url_normalized: normalizeUrl(url),
			title: job.title,
			locations: j(
				i % 2 ? ["Lisbon, Portugal"] : ["Remote - Europe", "Berlin, Germany"],
			),
			workplace_type: ["remote", "hybrid", "onsite", "unknown"][i % 4],
			department: "Engineering",
			employment_type: "Full-time",
			description_text: `We are hiring a ${job.title} to build our TypeScript and React product. You will work with a small team.`,
			apply_url: `${url}/apply`,
			read_status: job.id === "j10" ? "failed" : null,
			read_error: job.id === "j10" ? "The page answered 404" : null,
			published_at: at(0),
			// Closed postings (from 20261103032954_closed_postings): j3 found closed, j4 checked and
			// confirmed open by the user, j8 with an end date. Absent at earlier points.
			valid_through: job.id === "j8" ? at(40) : null,
			closed_at: job.id === "j3" ? at(5) : null,
			closed_reason:
				job.id === "j3"
					? "Lever no longer lists it (checked before Prepare)"
					: null,
			open_checked_at: job.id === "j3" || job.id === "j4" ? at(5) : null,
			open_confirmed_at: job.id === "j4" ? at(6) : null,
			first_seen_at: at(1),
			last_seen_at: at(6),
			created_at: at(1),
		};
	});
}

function documentRows(): Row[] {
	const rows: Row[] = [];
	for (const [i, job] of JOBS.entries()) {
		if (!DRAFTED.has(job.state)) continue;
		const app = `a${i + 1}`;
		const base = {
			user_id: U,
			application_id: app,
			created_by: "workflow",
			created_at: at(4),
		};
		rows.push(
			{
				...base,
				id: `${app}-cv1`,
				kind: "cv",
				format: "markdown",
				version: 1,
				content: "# Avery Quinn\n\nFrontend engineer.",
			},
			{
				...base,
				id: `${app}-cv2`,
				kind: "cv",
				format: "markdown",
				version: 2,
				content:
					"# Avery Quinn\n\nSenior frontend engineer.\n\n- Built Ledgerline, a TypeScript design system used by 40 engineers.",
				created_by: "user",
				source_version: 1,
				meta: j({ edited: true }),
				claims_check: j({
					passed: job.state !== "ready_for_review",
					flagged: job.state === "ready_for_review" ? 1 : 0,
				}),
				claims_passed: job.state === "ready_for_review" ? 0 : 1,
			},
			{
				...base,
				id: `${app}-cl1`,
				kind: "cover_letter",
				format: "markdown",
				content: "Dear hiring team,\n\nI build design systems.",
			},
			{
				...base,
				id: `${app}-fa1`,
				kind: "form_answers",
				format: "json",
				content: j([{ label: "Notice period", answer: "One month" }]),
			},
			{
				...base,
				id: `${app}-pdf`,
				kind: "cv",
				format: "pdf",
				version: 2,
				storage_key: `documents/${app}/cv-v2.pdf`,
			},
		);
	}
	return rows;
}

const HASHES = {
	cv: "sha256:0f1e2d",
	cover_letter: "sha256:3c4b5a",
	posting: "sha256:998877",
};

function reviewRows(): Row[] {
	const flag = {
		id: "flag-ledgerline",
		document: "cv",
		text: "- Built Ledgerline, a TypeScript design system used by 40 engineers.",
		context: "Bluefin Labs",
		occurrence: 0,
		reasons: [
			{ rule: "unchecked_line", message: "No evidence for '40 engineers'" },
		],
		confirmable: true,
		state: "open",
	};
	const claim = {
		document: "cv",
		text: "Built Ledgerline, a TypeScript design system used by 40 engineers.",
		supported: false,
		evidence: [],
		note: "The profile does not say how many engineers.",
		rejected: [],
	};
	const base = {
		user_id: U,
		document_hashes: j(HASHES),
		provider: "fake",
		ats_checked_at: null,
		segments: "[]",
		cited: "[]",
	};
	return [
		{
			...base,
			id: "rc-review",
			application_id: "a6",
			passed: 0,
			status: "claims_flagged",
			claims: j([claim]),
			issues: j([
				{
					rule: "unchecked_line",
					document: "cv",
					message: "Unchecked line",
					lines: [flag.text],
				},
			]),
			flags: j([flag]),
			created_at: at(4),
		},
		{
			...base,
			id: "rc-approved",
			application_id: "a7",
			passed: 1,
			status: "passed",
			claims: j([
				{
					...claim,
					supported: true,
					evidence: [
						{
							file: "experience/2023-bluefin.md",
							quote: "used by 40 engineers",
						},
					],
				},
			]),
			issues: "[]",
			flags: j([{ ...flag, state: "confirmed", confirmedAt: iso(5) }]),
			ats_checked_at: at(5),
			created_at: at(5),
		},
	];
}

/** The job whose run a worker was running when it died: its lease ran out long ago. */
export const INTERRUPTED = "j4";
/** The job whose run waits on an event whose time ran out while the app was closed. */
export const LAPSED_WAIT = "j1";

/** A job's application run: waiting on the user while active, ended otherwise. */
function applicationRun(job: { id: string; state: string }): Row {
	const base = {
		user_id: U,
		kind: APPLICATION_KIND,
		params: j({ userId: U, jobId: job.id }),
		priority: 5,
		run_after: at(1),
		executions: 2,
		created_at: at(1),
		updated_at: at(4),
	};
	if (job.id === INTERRUPTED)
		return {
			...base,
			status: "running",
			lease_owner: "runner:999999:gone",
			lease_until: at(4),
		};
	if (!ACTIVE.has(job.state))
		return {
			...base,
			status: "complete",
			result: j({ state: job.state }),
			ended_at: at(4),
		};
	return {
		...base,
		status: "waiting",
		wait_step: "wait-action#1",
		wait_event_type: "action",
		// Far ahead, except the one whose time ran out.
		wait_until: job.id === LAPSED_WAIT ? at(5) : at(4000),
	};
}

function flowRows() {
	const runs: Row[] = [];
	const steps: Row[] = [];
	for (const job of JOBS) {
		const id = applicationInstanceId(job.id);
		runs.push({ ...applicationRun(job), id });
		steps.push({
			run_id: id,
			key: "score#1",
			status: "complete",
			attempts: 1,
			result: j({ score: 70 }),
			updated_at: at(2),
		});
	}
	// The interrupted run's step, mid-attempt when its worker died.
	steps.push({
		run_id: applicationInstanceId(INTERRUPTED),
		key: "draft#1",
		status: "running",
		attempts: 1,
		updated_at: at(4),
	});
	runs.push({
		id: "scan-fixture-1",
		user_id: U,
		kind: SCAN_KIND,
		params: j({ userId: U, trigger: "timer" }),
		status: "complete",
		run_after: at(3),
		executions: 1,
		result: j({ found: 3 }),
		created_at: at(3),
		updated_at: at(3),
		ended_at: at(3),
	});
	steps.push({
		run_id: "scan-fixture-1",
		key: "providers#1",
		status: "complete",
		attempts: 1,
		result: "{}",
		updated_at: at(3),
	});
	const events: Row[] = [
		{
			id: "fe-1",
			run_id: applicationInstanceId("j7"),
			type: "action",
			payload: j({ action: "submit" }),
			delivered_to: null,
			created_at: at(5),
		},
	];
	return { flow_runs: runs, flow_steps: steps, flow_events: events };
}

function sourceProviderRows(): Row[] {
	const run = (provider: string, extra: Row) => ({
		provider,
		queries: 4,
		found: 2,
		fetched: 30,
		newJobs: 2,
		...extra,
	});
	const base = {
		user_id: U,
		created_at: at(0),
		updated_at: at(3),
		last_run_at: at(3),
	};
	return [
		{
			...base,
			provider: "job-board-search",
			enabled: 1,
			// Brave Search / SearXNG settings of earlier versions, and the old rotation turn.
			config: j({ backend: "searxng", searxngUrl: "http://searx.example.com" }),
			last_run: j(run("job-board-search", { turn: 3 })),
		},
		{
			...base,
			provider: "linkedin",
			enabled: 0,
			config: "{}",
			last_run: j(run("linkedin", { turn: 1, problem: "Signed out" })),
		},
		{
			...base,
			provider: "indeed",
			enabled: 1,
			config: j({
				stop: { kind: "check", at: iso(3), detail: "A check page" },
			}),
			last_run: j(run("indeed", { cursor: 2 })),
		},
		{
			...base,
			provider: "glassdoor",
			enabled: 0,
			config: "{}",
			last_run: null,
			last_run_at: null,
		},
		{
			...base,
			provider: "web-search",
			enabled: 1,
			// Web search's own searches of earlier versions, with the model's queries.
			config: j({
				queries: {
					ai: ["frontend engineer remote europe"],
					user: ["design engineer remote Europe", "react developer Lisbon"],
				},
			}),
			last_run: j(run("web-search", { turn: 0 })),
		},
	];
}

function chatRows() {
	const threads: Row[] = [
		{
			id: "t-profile",
			user_id: U,
			scope: "profile",
			application_id: null,
			key: "profile",
			created_at: at(2),
			updated_at: at(4),
		},
		{
			id: "t-app",
			user_id: U,
			scope: "application",
			application_id: "a6",
			key: "application:a6",
			created_at: at(4),
			updated_at: at(4),
		},
	];
	const msg = (
		id: string,
		thread: string,
		role: string,
		content: string,
		extra: Row = {},
	) => ({
		id,
		user_id: U,
		thread_id: thread,
		role,
		content,
		status: "done",
		proposals: "[]",
		created_at: at(4),
		...extra,
	});
	const messages: Row[] = [
		msg("m1", "t-profile", "user", "I led the Ledgerline migration in 2024."),
		msg("m2", "t-profile", "assistant", "Shall I add that to your profile?", {
			proposals: j([
				{
					id: "p1",
					type: "fact",
					question: "Did you lead a migration?",
					answer: "Yes, Ledgerline in 2024",
					status: "pending",
				},
			]),
		}),
		msg("m3", "t-app", "user", "Make the summary shorter."),
		// A reply the last worker left unanswered: the start marks it.
		msg("m4", "t-app", "assistant", "", { status: "working" }),
	];
	return { chat_threads: threads, chat_messages: messages };
}

function applicationExtras(): Record<string, Row[]> {
	return {
		application_transitions: JOBS.flatMap((job, i) =>
			job.state === "found"
				? []
				: [
						{
							id: `tr${i + 1}`,
							user_id: U,
							application_id: `a${i + 1}`,
							from_state: "found",
							to_state: job.state,
							reason: "fixture",
							actor: job.state === "dismissed" ? "user" : "workflow",
							created_at: at(4),
						},
					],
		),
		workflow_events: [
			{
				id: "we1",
				user_id: U,
				application_id: "a7",
				type: "action",
				idempotency_key: "approve-a7",
				payload: j({ action: "approve" }),
				sent_at: at(5),
				consumed_at: at(5),
				created_at: at(5),
			},
			{
				id: "we2",
				user_id: U,
				application_id: "a7",
				type: "action",
				idempotency_key: "submit-a7",
				payload: j({ action: "submit" }),
				sent_at: null,
				consumed_at: null,
				created_at: at(5),
			},
		],
		questions: [
			{
				id: "q1",
				user_id: U,
				application_id: "a5",
				key: "notice",
				question: "What is your notice period?",
				context: "Form field",
				answer: null,
				status: "open",
				profile_path: null,
				form_field: j({
					label: "Notice period",
					options: [],
					kind: "text",
					board: "linkedin",
				}),
				answered_at: null,
				created_at: at(4),
			},
			{
				id: "q2",
				user_id: U,
				application_id: "a5",
				key: "salary",
				question: "Expected salary?",
				context: null,
				answer: "EUR 85,000",
				status: "answered",
				profile_path: "answers.md",
				form_field: null,
				answered_at: at(4),
				created_at: at(4),
			},
		],
		profile_facts: [
			{
				id: "pf1",
				user_id: U,
				question_id: "q2",
				application_id: "a5",
				question: "Expected salary?",
				answer: "EUR 85,000",
				source: "user",
				question_source: "pipeline",
				board: "linkedin",
				answered_at: at(4),
			},
			{
				id: "pf2",
				user_id: U,
				question_id: null,
				application_id: null,
				question: "Work authorization in the EU?",
				answer: "Yes",
				source: "chat",
				question_source: "chat",
				board: null,
				answered_at: at(3),
			},
		],
		review_checks: reviewRows(),
		approvals: [
			{
				id: "ap1",
				user_id: U,
				application_id: "a7",
				document_hashes: j(HASHES),
				approved_at: at(5),
				revoked_at: null,
				revoked_reason: null,
			},
			{
				id: "ap2",
				user_id: U,
				application_id: "a8",
				document_hashes: j(HASHES),
				approved_at: at(5),
				revoked_at: at(5),
				revoked_reason: "edited after approval",
			},
			{
				id: "ap3",
				user_id: U,
				application_id: "a8",
				document_hashes: j(HASHES),
				approved_at: at(6),
				revoked_at: null,
				revoked_reason: null,
			},
		],
		submission_attempts: [
			{
				id: "sa1",
				user_id: U,
				application_id: "a8",
				attempt: 1,
				status: "submitted",
				mode: "auto",
				board: "greenhouse",
				url: "https://jobs.example.com/apply/8",
				screenshot_before_key: "proof/a8/before.png",
				screenshot_after_key: "proof/a8/after.png",
				proof: j({ confirmation: "Thanks for applying" }),
				error: null,
				resolution: null,
				started_at: at(6),
				finished_at: at(6),
			},
			{
				id: "sa2",
				user_id: U,
				application_id: "a9",
				attempt: 1,
				status: "needs_human",
				mode: "auto",
				board: "manual",
				url: null,
				proof: null,
				error: "No confirmation page",
				resolution: null,
				started_at: at(6),
				finished_at: at(6),
			},
			{
				id: "sa3",
				user_id: U,
				application_id: "a11",
				attempt: 1,
				status: "failed",
				mode: "auto",
				board: "ashby",
				url: null,
				proof: null,
				error: "Form changed",
				resolution: "not_sent",
				started_at: at(6),
				finished_at: at(6),
			},
		],
		dismissals: [
			{
				id: "d1",
				user_id: U,
				application_id: "a12",
				company_id: "c-removed",
				reasons: j(["location", "company"]),
				note: "Office only, far away",
				created_at: at(5),
			},
		],
		hidden_companies: [
			{ user_id: U, company_id: "c-removed", created_at: at(5) },
		],
		llm_usage: [
			{
				id: "lu1",
				user_id: U,
				application_id: "a3",
				task: "score",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				status: "settled",
				estimate_micros: 9000,
				input_tokens: 4200,
				output_tokens: 600,
				cached_input_tokens: 1000,
				cache_write_tokens: 200,
				cost_micros: 8100,
				model_calls: 1,
				price_basis: "list-2026-10",
				billing: "api",
				error: null,
				created_at: at(2),
				settled_at: at(2),
			},
			{
				id: "lu2",
				user_id: U,
				application_id: "a6",
				task: "tailor",
				provider: "claude-subscription",
				model: "claude-opus-5-5",
				status: "settled",
				estimate_micros: 0,
				model_calls: 3,
				billing: "subscription",
				created_at: at(4),
				settled_at: at(4),
			},
			{
				id: "lu3",
				user_id: U,
				application_id: null,
				task: "search_plan",
				provider: "openai",
				model: "gpt-5.5-mini",
				status: "reserved",
				estimate_micros: 2000,
				billing: "api",
				error: null,
				created_at: at(6),
				settled_at: null,
			},
			{
				// The paid Claude call behind the stop in subscription_pauses: the stop stays.
				id: "lu4",
				user_id: U,
				application_id: null,
				task: "score",
				provider: "claude-subscription:claude-opus-5-5",
				model: "claude-opus-5-5",
				status: "settled",
				estimate_micros: 90000,
				cost_micros: 42000,
				model_calls: 1,
				price_basis: "paid extra usage on the Claude plan",
				billing: "api",
				error: "Subscription paused (extra_usage): paid",
				created_at: at(5) - 600_000,
				settled_at: at(5) - 60_000,
			},
		],
	};
}

/** Every row, by table, as the latest schema has them. */
function fixtureRows(): Record<string, Row[]> {
	return {
		user: [
			{
				id: U,
				name: "Avery Quinn",
				email: LOCAL_USER_EMAIL,
				email_verified: 1,
				image: null,
				created_at: at(0),
				updated_at: at(0),
			},
		],
		profiles: [
			{
				id: "pr1",
				user_id: U,
				source_path: "/Users/example/profile",
				files: j(PROFILE_FILES),
				imported_at: at(0),
				created_at: at(0),
				updated_at: at(1),
			},
		],
		profile_records: [
			{
				kind: "about",
				data: {
					name: "Avery Quinn",
					email: "avery.quinn@example.com",
					phone: "+1 555 0100",
					location: "Lisbon, Portugal",
					summary: "Frontend engineer.",
				},
			},
			{
				kind: "experience",
				data: {
					company: "Bluefin Labs",
					title: "Senior Frontend Engineer",
					start: "2023",
					end: "",
					bullets: ["Built Ledgerline."],
				},
			},
			{
				kind: "project",
				data: {
					name: "Ledgerline",
					description: "A design system.",
					bullets: [],
				},
			},
			{ kind: "skill", data: { name: "TypeScript" } },
			{
				kind: "education",
				data: {
					school: "Example Polytechnic",
					field: "Computer Science",
					years: "2012 - 2016",
				},
			},
			{
				kind: "extra",
				data: { title: "Languages", text: "English, Portuguese" },
			},
		].map((r, i) => ({
			id: `rec${i + 1}`,
			user_id: U,
			kind: r.kind,
			position: i,
			data: j(r.data),
			source: "import",
			source_date: at(0),
			created_at: at(0),
			updated_at: at(0),
		})),
		filter_settings: [
			{
				user_id: U,
				settings: j({
					livesIn: "Portugal",
					citizenship: ["Portugal"],
					rightToWork: ["Portugal", "Spain"],
					keepRemoteFromHome: true,
					keepGlobalRemote: false,
					keepOnsiteIn: ["Portugal"],
					relocation: true,
					relocationCountries: ["Netherlands"],
					locationPrefilled: true,
					languages: ["English", "Portuguese"],
					roleKeywords: ["engineer", "developer", "typescript"],
					searchTitles: ["Senior Frontend Engineer"],
					excludeTitleKeywords: ["intern", "working student"],
					minScore: 55,
					prepareMinScore: 70,
				}),
				updated_at: at(1),
			},
		],
		companies: COMPANIES.map((c) => ({
			id: c.id,
			user_id: U,
			name: c.name,
			name_key: companyNameKey(c.name),
			source: c.source,
			source_key: c.key,
			discovered_from: c.source === "web" ? "web-search" : null,
			last_scanned_at: at(3),
			created_at: at(0),
			updated_at: at(3),
			...c.extra,
		})),
		jobs: jobRows(),
		applications: applicationRows(),
		documents: documentRows(),
		...applicationExtras(),
		...flowRows(),
		...chatRows(),
		source_providers: sourceProviderRows(),
		// After Applied: a8 (sent) heard back and is interviewing, a stage that never waits, so
		// no start's sweep adds to it whatever the date; a note on its stage and one on a3.
		application_stages: [
			{
				id: "st1",
				user_id: U,
				application_id: "a8",
				seq: 1,
				stage: "applied",
				occurred_on: "2026-10-26",
				automatic: 0,
				created_at: at(6),
			},
			{
				id: "st2",
				user_id: U,
				application_id: "a8",
				seq: 2,
				stage: "heard_back",
				occurred_on: "2026-10-28",
				automatic: 0,
				reminded_at: at(9),
				reminder_tried_at: at(8),
				created_at: at(8),
			},
			{
				id: "st3",
				user_id: U,
				application_id: "a8",
				seq: 3,
				stage: "interviewing",
				occurred_on: "2026-10-30",
				interview_round: 1,
				interview_at: at(12),
				automatic: 0,
				created_at: at(10),
			},
		],
		job_notes: [
			{
				id: "n1",
				user_id: U,
				application_id: "a8",
				stage_id: "st2",
				body: "Recruiter Dana Example wrote back.",
				created_at: at(8),
				updated_at: at(8),
			},
			{
				id: "n2",
				user_id: U,
				application_id: "a3",
				stage_id: null,
				body: "Referred by Lee Example.",
				created_at: at(3),
				updated_at: at(4),
			},
		],
		search_plans: [
			{
				user_id: U,
				ai: j([{ keywords: "frontend engineer", where: "remote-worldwide" }]),
				user: j([
					{ keywords: "typescript engineer", where: "onsite", place: "Lisbon" },
				]),
				basis: "ai",
				generated_at: at(6),
				updated_at: at(6),
			},
		],
		linkedin_settings: [
			{
				user_id: U,
				// Two searches and a collection (not a search: kept in the notice, not moved).
				search_urls: j([
					"https://www.linkedin.com/jobs/search/?keywords=frontend%20engineer&location=Portugal",
					"https://www.linkedin.com/jobs/search/?keywords=typescript&f_WT=2",
					"https://www.linkedin.com/jobs/collections/recommended/",
				]),
				daily_page_cap: 25,
				min_gap_seconds: 30,
				max_gap_seconds: 90,
				blocked_at: at(2),
				blocked_kind: "check",
				blocked_reason: "A security check",
				cleared_at: at(3),
				updated_at: at(3),
			},
		],
		linkedin_runs: [
			{
				id: "lr1",
				user_id: U,
				trigger: "timer",
				pages_used: 4,
				listings_read: 50,
				jobs_inserted: 3,
				duplicates: 12,
				outcome: "done",
				stop_reason: null,
				started_at: at(3),
				finished_at: at(3),
			},
		],
		linkedin_pages: [
			{ id: "lp1", user_id: U, run_id: "lr1", opened_at: at(3) },
			{ id: "lp2", user_id: U, run_id: null, opened_at: at(3) },
		],
		linkedin_seen: [
			{
				user_id: U,
				linkedin_job_id: "4100000001",
				outcome: "inserted",
				seen_at: at(3),
			},
			{
				user_id: U,
				linkedin_job_id: "4100000002",
				outcome: "duplicate",
				seen_at: at(3),
			},
		],
		scan_runs: [
			{
				id: "sr1",
				user_id: U,
				trigger: "timer",
				stats: j({ companies: 9, jobs: 3 }),
				started_at: at(3),
				finished_at: at(3),
				flow_run_id: "scan-fixture-1",
				sources: j([
					{
						id: "ashby",
						label: "Ashby",
						status: "ok",
						searches: [],
						queries: 1,
						pagesRead: null,
						results: 4,
						read: 4,
						duplicates: 1,
						newJobIds: ["j1"],
						dropped: [],
					},
				]),
				progress: null,
			},
			{
				id: "sr2",
				user_id: U,
				trigger: "manual",
				stats: null,
				started_at: at(2),
				finished_at: null,
				flow_run_id: null,
				sources: "[]",
				progress: null,
			},
		],
		spending_settings: [
			{
				user_id: U,
				enabled: 1,
				monthly_cap_micros: 35_000_000,
				extra_usage_off_confirmed_at: at(2),
				subscription_daily_calls: 120,
				updated_at: at(2),
			},
		],
		submission_settings: [{ user_id: U, paused: 0, updated_at: at(2) }],
		// What the Claude plan had used, and OfferFinch's share of it, as last read.
		plan_usage: [
			{
				user_id: U,
				vendor: "anthropic",
				state: JSON.stringify({
					vendor: "anthropic",
					checkedAt: new Date(at(5)).toISOString(),
					account: {
						plan: "max",
						extraUsage: {
							enabled: false,
							used: null,
							limit: null,
							currency: null,
						},
						credits: null,
					},
					windows: [
						{
							id: "five_hour",
							label: "Session",
							kind: "session",
							usedPercent: 42,
							appPercent: 7,
							resetsAt: new Date(at(5) + 4 * 3_600_000).toISOString(),
							durationMins: 300,
							sampledAt: new Date(at(5)).toISOString(),
						},
					],
				}),
				updated_at: at(5),
			},
		],
		subscription_pauses: [
			{
				user_id: U,
				vendor: "anthropic",
				paused_at: at(5),
				reason: "extra_usage",
			},
		],
	};
}

function columns(db: Database, table: string): Set<string> {
	const rows = db.$client.pragma(`table_info(${JSON.stringify(table)})`) as {
		name: string;
	}[];
	return new Set(rows.map((r) => r.name));
}

/** The user tables this schema has (not SQLite's, not the migration ledger). */
export function userTables(db: Database): string[] {
	return (
		db.$client
			.prepare(
				"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__migrations' order by name",
			)
			.all() as { name: string }[]
	).map((r) => r.name);
}

/** Tables the fixture fills, for the check that every table of the latest schema has rows. */
export const FIXTURE_TABLES = [...Object.keys(fixtureRows()), "app_settings"];

/**
 * A database at schema point `upTo` (a migration name: that one and every one before it), filled.
 */
export async function buildDatabaseAt(
	file: string,
	upTo: string,
): Promise<void> {
	const end = MIGRATIONS.findIndex((m) => m.name === upTo);
	if (end < 0) throw new Error(`No migration ${upTo}`);
	const db = openSqlite(file);
	await migrate(db, { migrations: MIGRATIONS.slice(0, end + 1) });
	const client = db.$client;
	// Foreign keys on: a fixture row that points nowhere fails here, not in a migration.
	client.pragma("foreign_keys = ON");
	const tables = new Set(userTables(db));
	client.transaction(() => {
		for (const [table, rows] of Object.entries(fixtureRows())) {
			if (!tables.has(table)) continue;
			const have = columns(db, table);
			for (const row of rows) {
				const keys = Object.keys(row).filter((k) => have.has(k));
				client
					.prepare(
						`insert into "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) values (${keys.map(() => "?").join(", ")})`,
					)
					.run(...keys.map((k) => row[k] as never));
			}
		}
	})();
	const store = new SettingsStore(db);
	const latest = end === MIGRATIONS.length - 1;
	for (const [name, value] of Object.entries(settingsFor(latest)))
		await store.set(name as SettingName, value as never);
	db.$close();
}
