import {
	Archive,
	Bell,
	Building2,
	Check,
	ChevronDown,
	ChevronRight,
	Database,
	ExternalLink,
	FileCheck2,
	FileText,
	Filter,
	House,
	Inbox,
	Link2,
	MessageCircleQuestion,
	PanelRight,
	Pencil,
	RefreshCw,
	Search,
	Send,
	Settings,
	SlidersHorizontal,
	TriangleAlert,
	UserRound,
	Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton, SkulletProvider } from "skullet/react";
import { Stage, Window } from "../../kit";
import { CV, JOBS, type Job, POSTINGS } from "./data";
import "./of.css";

// OfferFinch Native: one macOS direction for the OfferFinch desktop app.
// Each Stage is one still of a 1440 x 900 window at 1:1 on a quiet desktop,
// so 13 px type reads as 13 px. The window is whole on purpose: this is a
// design comp of the real app, not a marketing crop (see REHEARSAL.md).
//
// The look comes from the Grid mark: a 4 px grid, cells that part by a hair,
// one green cell. Radii are steps of that grid (4 chips and cells' parents,
// 6 controls and rows, 10 grouped panels and menus). Green is the beak's one
// signal: high fit and traced claims. Controls take the system accent (blue
// by default), as every native app does.
//
// Icons: lucide-react, the app's own pack (apps/desktop already depends on
// it), at 16 px in the sidebar and 15 px in toolbars, stroke 1.75.

const W = 1440;
const H = 900;
const SIDE = 212;

/* ------------------------------------------------------------------ mark */

const GRID = [
	"........",
	"....###.",
	"...#.##G",
	"..#####.",
	".#####..",
	"#####...",
	"#..#....",
	"........",
];

/** The Grid mark, drawn from docs/brand/marks.mjs gridCells: cells part above 32 px, touch below. */
function Mark({ size = 16 }: { size?: number }) {
	const gap = size > 32 ? 0.5 : 0;
	return (
		<svg
			className="of-mark"
			width={size}
			height={size}
			viewBox="0 0 32 32"
			aria-hidden
		>
			{GRID.flatMap((row, y) =>
				[...row].map((c, x) =>
					c === "." ? null : (
						<rect
							key={`${x}-${y}`}
							x={x * 4 + gap}
							y={y * 4 + gap + 2}
							width={4 - 2 * gap}
							height={4 - 2 * gap}
							fill={c === "G" ? "var(--of-brand)" : "currentColor"}
						/>
					),
				),
			)}
		</svg>
	);
}

/** The mark's cells as a meter: each cell one unit (a claim, a company, a tenth of fit). */
function Cells({
	total,
	on,
	tone = "brand",
	warn = [],
	size = 7,
	perRow,
}: {
	total: number;
	on: number;
	tone?: "brand" | "ink" | "accent";
	warn?: number[];
	size?: number;
	perRow?: number;
}) {
	return (
		<span
			className="of-cells"
			data-tone={tone}
			style={{
				["--c" as string]: `${size}px`,
				gridTemplateColumns: perRow ? `repeat(${perRow}, var(--c))` : undefined,
			}}
		>
			{Array.from({ length: total }, (_, i) => (
				<i
					key={i}
					data-on={i < on || undefined}
					data-warn={warn.includes(i) || undefined}
				/>
			))}
		</span>
	);
}

/* --------------------------------------------------------------- sidebar */

type Nav =
	| "home"
	| "inbox"
	| "questions"
	| "applied"
	| "rejected"
	| "profile"
	| "settings";

const NAV: { id: Nav; label: string; icon: ReactNode; count?: number }[] = [
	{ id: "home", label: "Home", icon: <House /> },
	{ id: "inbox", label: "Inbox", icon: <Inbox />, count: 4 },
	{
		id: "questions",
		label: "Questions",
		icon: <MessageCircleQuestion />,
		count: 3,
	},
	{ id: "applied", label: "Applied", icon: <Send />, count: 12 },
	{ id: "rejected", label: "Rejected", icon: <Archive /> },
];

const NAV_YOU: typeof NAV = [
	{ id: "profile", label: "Profile", icon: <UserRound /> },
	{ id: "settings", label: "Settings", icon: <Settings /> },
];

function SideItem({
	item,
	active,
}: {
	item: (typeof NAV)[number];
	active: boolean;
}) {
	return (
		<div className="of-side__item" data-active={active || undefined}>
			<span className="of-side__icon">{item.icon}</span>
			<span className="of-side__label">{item.label}</span>
			{item.count ? <span className="of-side__count">{item.count}</span> : null}
		</div>
	);
}

function Sidebar({ active, scanning }: { active: Nav; scanning?: boolean }) {
	return (
		<div className="of-side">
			<div className="of-side__list">
				{NAV.map((item) => (
					<SideItem key={item.id} item={item} active={item.id === active} />
				))}
				<div className="of-side__group">You</div>
				{NAV_YOU.map((item) => (
					<SideItem key={item.id} item={item} active={item.id === active} />
				))}
			</div>
			<div className="of-side__foot">
				<Mark size={16} />
				{scanning ? (
					<div className="of-side__status">
						<span className="of-side__status-title">Scanning 6 of 9</span>
						<Cells total={9} on={6} tone="ink" size={5} />
					</div>
				) : (
					<div className="of-side__status">
						<span className="of-side__status-title">Scanned 12 min ago</span>
						<span className="of-side__status-sub">Next scan at 14:00</span>
					</div>
				)}
			</div>
		</div>
	);
}

/* -------------------------------------------------------------- controls */

function Btn({
	children,
	primary,
	icon,
	quiet,
	off,
}: {
	children?: ReactNode;
	primary?: boolean;
	icon?: ReactNode;
	quiet?: boolean;
	off?: boolean;
}) {
	return (
		<span
			className="of-btn"
			data-off={off || undefined}
			data-primary={primary || undefined}
			data-quiet={quiet || undefined}
			data-icon={icon && !children ? true : undefined}
		>
			{icon}
			{children}
		</span>
	);
}

function SearchField({ width = 220 }: { width?: number }) {
	return (
		<span className="of-search" style={{ width }}>
			<Search />
			<span className="of-search__text">Search</span>
			<kbd>⌘K</kbd>
		</span>
	);
}

function Seg({ items, value }: { items: ReactNode[]; value: number }) {
	return (
		<span className="of-seg">
			{items.map((item, i) => (
				<span
					key={i}
					className="of-seg__item"
					data-on={i === value || undefined}
				>
					{item}
				</span>
			))}
		</span>
	);
}

function Sep() {
	return <span className="of-tsep" />;
}

/* ----------------------------------------------------------------- inbox */

function StatusLine({ job }: { job: Job }) {
	if (job.status === "answers")
		return (
			<span className="of-status" data-tone="warn">
				{job.questions} question{job.questions === 1 ? "" : "s"} to answer
			</span>
		);
	if (job.status === "drafting")
		return (
			<span className="of-status" data-tone="faint">
				<span className="of-spin" /> Drafting CV
			</span>
		);
	if (job.status === "applied")
		return (
			<span className="of-status" data-tone="faint">
				Applied
			</span>
		);
	return <span className="of-status">Ready for review</span>;
}

function ListRow({ job, selected }: { job: Job; selected?: boolean }) {
	return (
		<div
			className="of-row"
			data-selected={selected || undefined}
			data-unread={job.status === "ready" && !selected ? true : undefined}
		>
			<div className="of-row__top">
				<span className="of-row__company">{job.company}</span>
				<span className="of-row__when">{job.when}</span>
			</div>
			<div className="of-row__role">{job.role}</div>
			<div className="of-row__meta">
				<span className="of-fit" data-high={job.fit >= 90 || undefined}>
					{job.fit}
				</span>
				<StatusLine job={job} />
				<span className="of-row__board">{job.board}</span>
			</div>
		</div>
	);
}

function List({ selected }: { selected: string }) {
	return (
		<div className="of-list">
			<div className="of-list__head">
				<Seg
					items={[
						<>
							To review <b>4</b>
						</>,
						<>
							Answers <b>2</b>
						</>,
						<>
							All <b>48</b>
						</>,
					]}
					value={2}
				/>
				<span className="of-list__sort">
					Fit <ChevronDown />
				</span>
			</div>
			<div className="of-list__rows">
				{JOBS.map((job) => (
					<ListRow key={job.id} job={job} selected={job.id === selected} />
				))}
			</div>
		</div>
	);
}

function Posting({ id }: { id: keyof typeof POSTINGS }) {
	const p = POSTINGS[id];
	return (
		<div className="of-pane of-posting">
			<div className="of-pane__head">
				<span className="of-pane__title">Posting</span>
				<span className="of-link">
					Open original <ExternalLink />
				</span>
			</div>
			<div className="of-posting__body">
				<p>{p.intro}</p>
				{p.sections.map((s) => (
					<div key={s.head} className="of-posting__section">
						<div className="of-posting__h">{s.head}</div>
						<ul>
							{s.lines.map((l) => (
								<li key={l.text} data-mark={l.mark}>
									<span className="of-posting__tick">
										{l.mark === "met" ? (
											<Check />
										) : (
											<span className="of-dash" />
										)}
									</span>
									{l.text}
								</li>
							))}
						</ul>
					</div>
				))}
				{p.extra.map((x) => (
					<div key={x.head} className="of-posting__section">
						<div className="of-posting__h">{x.head}</div>
						<p>{x.text}</p>
					</div>
				))}
			</div>
		</div>
	);
}

function Page() {
	return (
		<div className="of-paper">
			<div className="of-paper__name">{CV.name}</div>
			<div className="of-paper__contact">{CV.contact}</div>
			<div className="of-paper__h">Summary</div>
			<p>{CV.summary}</p>
			<div className="of-paper__h">Experience</div>
			{CV.roles.map((r) => (
				<div key={r.org} className="of-paper__role">
					<div className="of-paper__role-top">
						<b>
							{r.title}, {r.org}
						</b>
						<span>{r.when}</span>
					</div>
					<ul>
						{r.bullets.map((b) => (
							<li key={b}>{b}</li>
						))}
					</ul>
				</div>
			))}
			<div className="of-paper__h">Skills</div>
			<p>{CV.skills}</p>
		</div>
	);
}

function Documents({ loading }: { loading?: boolean }) {
	return (
		<div className="of-pane of-docs">
			<div className="of-pane__head">
				<Seg
					items={[
						"CV",
						"Letter",
						<>
							Answers <b>3</b>
						</>,
					]}
					value={0}
				/>
				<span className="of-pane__end">
					<span className="of-faint">v2 · PDF</span>
					<Btn icon={<Pencil />} quiet />
					<Btn icon={<FileText />} quiet />
				</span>
			</div>
			<div className="of-docs__well">
				<Skeleton loading={Boolean(loading)} label="Loading the CV">
					<Page />
				</Skeleton>
			</div>
		</div>
	);
}

function InspectorBody() {
	return (
		<>
			<section className="of-insp__sec">
				<div className="of-insp__label">Fit</div>
				<div className="of-insp__fit">
					<span className="of-insp__big">94</span>
					<div className="of-insp__fit-side">
						<Cells total={10} on={9} size={8} />
						<span className="of-insp__cap">7 of 8 requirements met</span>
					</div>
				</div>
				<div className="of-insp__note">
					Missing: Storybook. Not in your profile;{" "}
					<span className="of-link">add it</span> if you have used it.
				</div>
			</section>
			<section className="of-insp__sec">
				<div className="of-insp__label">
					Checks <span className="of-insp__label-end">Passed</span>
				</div>
				<Cells total={35} on={35} size={7} perRow={18} />
				<ul className="of-checks">
					<li>
						<Check /> All 35 claims trace to your profile
					</li>
					<li>
						<Check /> Fixed rules hold: dates, titles, contact
					</li>
					<li>
						<Check /> PDF text is readable by applicant systems
					</li>
				</ul>
			</section>
			<section className="of-insp__sec">
				<div className="of-insp__label">
					Flags <span className="of-insp__label-end">1</span>
				</div>
				<div className="of-flag">
					<TriangleAlert />
					<div>
						<div className="of-flag__title">
							Hybrid, 3 days a week in Lisbon
						</div>
						<div className="of-flag__sub">
							You live in Ankara. Kept because your job filter allows
							relocating for hybrid roles in Europe.
						</div>
					</div>
				</div>
			</section>
			<section className="of-insp__sec">
				<div className="of-insp__label">After you approve</div>
				<ol className="of-next">
					<li>OfferFinch opens the Greenhouse form</li>
					<li>You paste the answers and attach the PDFs</li>
					<li>You record the day with I submitted this</li>
				</ol>
			</section>
			<section className="of-insp__rows">
				{[
					["Cost", "$0.04"],
					["Form answers", "3 drafted"],
					["History", "4 events"],
				].map(([k, v]) => (
					<div key={k} className="of-insp__row">
						<ChevronRight />
						<span>{k}</span>
						<span className="of-insp__row-v">{v}</span>
					</div>
				))}
			</section>
		</>
	);
}

function Inspector({ loading }: { loading?: boolean }) {
	return (
		<aside className="of-insp">
			<Skeleton loading={Boolean(loading)} label="Loading checks">
				<InspectorBody />
			</Skeleton>
		</aside>
	);
}

function InboxScreen({
	selected,
	loading,
}: {
	selected: keyof typeof POSTINGS;
	loading?: boolean;
}) {
	const p = POSTINGS[selected];
	return (
		<div className="of-inbox">
			<List selected={selected} />
			<div className="of-detail">
				<div className="of-detail__head">
					<div className="of-detail__title-row">
						<span className="of-detail__title">{p.title}</span>
						<span className="of-pill" data-tone="ready">
							Ready for review
						</span>
					</div>
					<div className="of-detail__meta">
						{p.meta.map((m, i) => (
							<span key={m}>{i === 0 ? <b>{m}</b> : m}</span>
						))}
					</div>
				</div>
				<div className="of-detail__split">
					<Posting id={selected} />
					<Documents loading={loading} />
				</div>
			</div>
			<Inspector loading={loading} />
		</div>
	);
}

function InboxToolbar({ checking }: { checking?: boolean }) {
	return (
		<div className="of-toolbar">
			<SearchField width={200} />
			<Btn icon={<RefreshCw />} quiet />
			<Sep />
			<Btn>Reject…</Btn>
			<Btn primary off={checking}>
				Approve
			</Btn>
			<Sep />
			<Btn icon={<PanelRight />} quiet />
		</div>
	);
}

/* ------------------------------------------------------------------ home */

function Group({
	label,
	end,
	children,
}: {
	label: string;
	end?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="of-group">
			<div className="of-group__label">
				{label}
				{end ? <span className="of-group__end">{end}</span> : null}
			</div>
			<div className="of-group__box">{children}</div>
		</div>
	);
}

function TaskRow({
	icon,
	tone,
	title,
	sub,
	fit,
	when,
}: {
	icon: ReactNode;
	tone?: "warn" | "accent";
	title: ReactNode;
	sub: string;
	fit?: number;
	when: string;
}) {
	return (
		<div className="of-task">
			<span className="of-task__icon" data-tone={tone}>
				{icon}
			</span>
			<div className="of-task__text">
				<div className="of-task__title">{title}</div>
				<div className="of-task__sub">{sub}</div>
			</div>
			{fit ? (
				<span className="of-fit" data-high={fit >= 90 || undefined}>
					{fit}
				</span>
			) : (
				<span />
			)}
			<span className="of-task__when">{when}</span>
			<ChevronRight className="of-task__chev" />
		</div>
	);
}

const NEW = [
	{
		company: "Wren Analytics",
		role: "Senior Frontend Engineer",
		fit: 89,
		where: "Remote, Europe",
	},
	{
		company: "Saltmarsh Games",
		role: "UI Engineer, Tools",
		fit: 84,
		where: "Hybrid, Berlin",
	},
];

const SAMPLE = [
	{
		company: "Cobalt Insurance",
		role: "Frontend Engineer",
		fit: 80,
		where: "Remote, Europe",
	},
	{
		company: "Harbor Mobility",
		role: "Senior Product Engineer",
		fit: 77,
		where: "Hybrid, Amsterdam",
	},
	{
		company: "Mosaic Learning",
		role: "Design Systems Engineer",
		fit: 75,
		where: "Remote, Worldwide",
	},
];

function MatchRow({ m }: { m: (typeof NEW)[number] }) {
	return (
		<div className="of-match">
			<span className="of-fit" data-high={m.fit >= 90 || undefined}>
				{m.fit}
			</span>
			<span className="of-match__role">
				<b>{m.company}</b> {m.role}
			</span>
			<span className="of-match__where">{m.where}</span>
			<span className="of-match__when">just now</span>
		</div>
	);
}

function HomeScreen() {
	return (
		<div className="of-home">
			<div className="of-home__hello">
				<Mark size={40} />
				<div>
					<div className="of-home__title">Good afternoon, Sam</div>
					<div className="of-home__sub">
						4 applications are ready for review and 3 questions need your
						answer.
					</div>
				</div>
			</div>
			<div className="of-home__grid">
				<div className="of-home__main">
					<Group
						label="Needs you"
						end={<span className="of-link">Open Inbox</span>}
					>
						<TaskRow
							icon={<FileCheck2 />}
							tone="accent"
							title={
								<>
									<b>Review</b> Frontend Engineer, Design System at Nimbus Labs
								</>
							}
							sub="CV and letter drafted, 35 of 35 claims traced"
							fit={94}
							when="2h"
						/>
						<TaskRow
							icon={<FileCheck2 />}
							tone="accent"
							title={
								<>
									<b>Review</b> Senior Backend Engineer at Orbit Freight
								</>
							}
							sub="CV and letter drafted, 28 of 28 claims traced"
							fit={91}
							when="3h"
						/>
						<TaskRow
							icon={<MessageCircleQuestion />}
							tone="warn"
							title={
								<>
									<b>Answer</b> 2 questions for Halcyon Health
								</>
							}
							sub="Notice period, and whether you need a visa sponsor"
							fit={88}
							when="5h"
						/>
						<TaskRow
							icon={<FileCheck2 />}
							tone="accent"
							title={
								<>
									<b>Review</b> Senior Frontend Engineer at Juniper Maps
								</>
							}
							sub="CV and letter drafted, 31 of 31 claims traced"
							fit={86}
							when="Yesterday"
						/>
					</Group>
					<Group
						label="New matches"
						end={
							<span className="of-faint">
								<span className="of-spin" /> Reading Kestrel Bank
							</span>
						}
					>
						{NEW.map((m) => (
							<MatchRow key={m.company} m={m} />
						))}
						<Skeleton loading label="Scoring new matches">
							{SAMPLE.map((m) => (
								<MatchRow key={m.company} m={m} />
							))}
						</Skeleton>
					</Group>
					<Group
						label="Applied recently"
						end={<span className="of-link">Applied</span>}
					>
						{[
							[
								"Brightwater Studio",
								"Senior UI Engineer",
								"Sun",
								"Interview invite",
								"good",
								"Lever",
							],
							[
								"Fernhill Robotics",
								"Frontend Engineer, Tools",
								"Sat",
								"No reply yet",
								"",
								"Greenhouse",
							],
							[
								"Quayside Energy",
								"Product Engineer",
								"Oct 28",
								"No reply yet",
								"",
								"Ashby",
							],
							[
								"Marlow Books",
								"Senior Frontend Engineer",
								"Oct 27",
								"Viewed by recruiter",
								"",
								"LinkedIn",
							],
						].map(([c, r, d, st, tone, b]) => (
							<div key={c} className="of-applied">
								<span className="of-applied__day">{d}</span>
								<span className="of-match__role">
									<b>{c}</b> {r}
								</span>
								<span
									className="of-applied__state"
									data-tone={tone || undefined}
								>
									{st}
								</span>
								<span className="of-applied__board">{b}</span>
							</div>
						))}
					</Group>
				</div>
				<div className="of-home__side">
					<Group label="Scans" end={<span className="of-link">Pause</span>}>
						<div className="of-stat">
							<div className="of-stat__row">
								<span>Scanning 6 of 9 companies</span>
								<span className="of-faint">started 13:58</span>
							</div>
							<Cells total={9} on={6} tone="ink" size={10} />
							<div className="of-kv">
								<span>Last full scan</span>
								<span>12:00 · 48 read, 3 new</span>
								<span>Next</span>
								<span>14:00, then hourly</span>
							</div>
						</div>
					</Group>
					<Group
						label="This month"
						end={<span className="of-link">Spending</span>}
					>
						<div className="of-stat">
							<div className="of-stat__money">
								<span className="of-stat__big">$3.12</span>
								<span className="of-faint">of $20.00 cap</span>
							</div>
							<Cells total={20} on={3} tone="ink" size={10} />
							<div className="of-kv">
								<span>Fit scoring</span>
								<span>$0.84</span>
								<span>Tailoring</span>
								<span>$1.96</span>
								<span>Claims check</span>
								<span>$0.32</span>
							</div>
						</div>
					</Group>
					<Group label="Pipeline">
						{[
							["Ready for review", "4"],
							["Waiting for your answers", "3"],
							["Applied this month", "12"],
							["Rejected by your job filter", "31"],
						].map(([k, v]) => (
							<div key={k} className="of-line">
								<span>{k}</span>
								<span className="of-line__v">{v}</span>
							</div>
						))}
					</Group>
					<Group
						label="Watching"
						end={<span className="of-link">Watchlist</span>}
					>
						{[
							["Nimbus Labs", "Greenhouse · 14 open", ""],
							["Kestrel Bank", "Reading now", "busy"],
							["Orbit Freight", "Ashby · 9 open", ""],
							["Halcyon Health", "Board moved, check it", "warn"],
						].map(([c, v, tone]) => (
							<div key={c} className="of-watch">
								<span className="of-watch__dot" data-tone={tone || undefined} />
								{c}
								<span className="of-watch__v">{v}</span>
							</div>
						))}
					</Group>
				</div>
			</div>
		</div>
	);
}

function HomeToolbar() {
	return (
		<div className="of-toolbar">
			<SearchField />
			<Sep />
			<Btn icon={<RefreshCw className="of-rot" />}>Scanning…</Btn>
		</div>
	);
}

/* -------------------------------------------------------------- settings */

const SECTIONS: { label: string; icon: ReactNode; group: string }[] = [
	{ label: "Models", icon: <SlidersHorizontal />, group: "Pipeline" },
	{ label: "Job filter", icon: <Filter />, group: "Pipeline" },
	{ label: "Watchlist", icon: <Building2 />, group: "Pipeline" },
	{ label: "Documents", icon: <FileText />, group: "Pipeline" },
	{ label: "Spending", icon: <Wallet />, group: "Pipeline" },
	{ label: "Submissions", icon: <Send />, group: "Pipeline" },
	{ label: "LinkedIn", icon: <Link2 />, group: "Pipeline" },
	{ label: "Notifications", icon: <Bell />, group: "App" },
	{ label: "General", icon: <Settings />, group: "App" },
	{ label: "Your data", icon: <Database />, group: "App" },
];

function Popup({ children }: { children: ReactNode }) {
	return (
		<span className="of-popup">
			{children}
			<ChevronDown />
		</span>
	);
}

function Toggle({ on }: { on?: boolean }) {
	return <span className="of-toggle" data-on={on || undefined} />;
}

function FormRow({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="of-form-row">
			<div className="of-form-row__text">
				<div className="of-form-row__label">{label}</div>
				{hint ? <div className="of-form-row__hint">{hint}</div> : null}
			</div>
			<div className="of-form-row__control">{children}</div>
		</div>
	);
}

function SettingsScreen() {
	let last = "";
	return (
		<div className="of-settings">
			<div className="of-settings__nav">
				{SECTIONS.map((s, i) => {
					const head = s.group !== last ? s.group : null;
					last = s.group;
					return (
						<div key={s.label}>
							{head ? <div className="of-side__group">{head}</div> : null}
							<div className="of-side__item" data-active={i === 0 || undefined}>
								<span className="of-side__icon">{s.icon}</span>
								<span className="of-side__label">{s.label}</span>
							</div>
						</div>
					);
				})}
			</div>
			<div className="of-settings__body">
				<div className="of-settings__intro">
					<div className="of-settings__title">Models</div>
					<div className="of-settings__sub">
						The model behind each step and how it is paid for. API calls count
						toward your spending cap.
					</div>
				</div>
				<Group label="API keys">
					<FormRow
						label="Anthropic API key"
						hint="Stored in your macOS Keychain"
					>
						<span className="of-key">sk-ant-•••• 4f2a</span>
						<Btn>Change…</Btn>
					</FormRow>
					<FormRow label="OpenAI API key" hint="Not set">
						<Btn>Add key…</Btn>
					</FormRow>
				</Group>
				<Group label="Who does each step">
					<FormRow
						label="Fit scoring"
						hint="Scores each job that passes your job filter"
					>
						<Popup>Claude subscription</Popup>
						<Btn quiet>Test</Btn>
					</FormRow>
					<FormRow
						label="Tailoring"
						hint="Drafts the CV, letter and form answers"
					>
						<Popup>Claude subscription</Popup>
						<Btn quiet>Test</Btn>
					</FormRow>
					<FormRow
						label="Claims check"
						hint="Always a different vendor from tailoring, so no draft is checked by the model family that wrote it"
					>
						<Popup>Codex subscription</Popup>
						<Btn quiet>Test</Btn>
					</FormRow>
				</Group>
				<Group label="Limits">
					<FormRow
						label="Monthly spending cap"
						hint="Calls are held, not dropped, when the cap is reached"
					>
						<span className="of-field">
							<span className="of-faint">$</span>20.00
						</span>
					</FormRow>
					<FormRow label="Ask before a call over $0.50">
						<Toggle on />
					</FormRow>
					<FormRow
						label="Use test models"
						hint="Fake models for trying the app without spending"
					>
						<Toggle />
					</FormRow>
				</Group>
				<Group label="Privacy">
					<FormRow
						label="Replace email and phone before a model reads your CV"
						hint="They are put back only in the PDFs on this Mac"
					>
						<Toggle on />
					</FormRow>
					<FormRow
						label="Keep prompts and replies"
						hint="For checking what a model was asked; stored on this Mac only"
					>
						<Popup>For 30 days</Popup>
					</FormRow>
				</Group>
			</div>
		</div>
	);
}

/* ----------------------------------------------------------------- shell */

function App({
	nav,
	title,
	sub,
	toolbar,
	scanning,
	children,
}: {
	nav: Nav;
	title: string;
	sub?: string;
	toolbar: ReactNode;
	scanning?: boolean;
	children: ReactNode;
}) {
	return (
		<Window
			className="of-window"
			lightsSize="large"
			sidebar={<Sidebar active={nav} scanning={scanning} />}
			sidebarWidth={SIDE}
			title={title}
			lead={sub ? <span className="of-heading-sub">{sub}</span> : undefined}
			toolbar={toolbar}
			style={{ position: "absolute", left: 40, top: 40, width: W, height: H }}
		>
			{children}
		</Window>
	);
}

const SKULLET_THEME = {
	radius: "4px",
	animation: "shimmer" as const,
	light: { base: "rgba(0, 0, 0, 0.07)", highlight: "rgba(0, 0, 0, 0.03)" },
	dark: {
		base: "rgba(255, 255, 255, 0.08)",
		highlight: "rgba(255, 255, 255, 0.04)",
	},
};

function Shot({
	id,
	theme,
	children,
}: {
	id: string;
	theme: "light" | "dark";
	children: ReactNode;
}) {
	const only = new URLSearchParams(window.location.search).get("only");
	if (only && only !== id) return null;
	return (
		<div id={id} className="of-shot">
			<SkulletProvider theme={SKULLET_THEME} mode={theme}>
				<Stage
					width={W + 80}
					height={H + 80}
					theme={theme}
					fidelity="realistic"
					unframed
					initial={{}}
					className="of"
					greys="cool"
				>
					{() => children}
				</Stage>
			</SkulletProvider>
		</div>
	);
}

export default function OfferFinchNative() {
	// ?only=<shot id> renders one still at the top of the page, so each is filmed in view
	const only = new URLSearchParams(window.location.search).get("only");
	return (
		<div className="of-sheet" data-only={only ?? undefined}>
			<Shot id="inbox-dark" theme="dark">
				<App
					nav="inbox"
					title="Inbox"
					sub="4 to review"
					toolbar={<InboxToolbar />}
				>
					<InboxScreen selected="nimbus" />
				</App>
			</Shot>
			<Shot id="inbox-light" theme="light">
				<App
					nav="inbox"
					title="Inbox"
					sub="4 to review"
					toolbar={<InboxToolbar checking />}
				>
					<InboxScreen selected="orbit" loading />
				</App>
			</Shot>
			<Shot id="home-dark" theme="dark">
				<App nav="home" title="Home" toolbar={<HomeToolbar />} scanning>
					<HomeScreen />
				</App>
			</Shot>
			<Shot id="settings-dark" theme="dark">
				<App
					nav="settings"
					title="Settings"
					toolbar={
						<div className="of-toolbar">
							<SearchField />
						</div>
					}
				>
					<SettingsScreen />
				</App>
			</Shot>
		</div>
	);
}
