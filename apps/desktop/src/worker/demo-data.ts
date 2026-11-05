/**
 * Try-it mode's fabricated data (docs/decisions.md, 2026-11-05): the sample profile, the sample
 * job rules and eight sample jobs. Nothing here describes a real person or company; the e2e runs
 * use the same resume. Plain data only, so the e2e can import it too.
 */

/** The fabricated resume (Sam Rivera), also the e2e runs' resume. */
export const SAMPLE_RESUME = `Sam Rivera
sam.rivera@example.test · +1 555 010 0199 · linkedin.com/in/samrivera-example
Fabricated resume for end-to-end runs. Nothing here describes a real person.
Skills: TypeScript, React, Next.js, Node.js, PostgreSQL, Cloudflare Workers, Go, Tailwind
Senior Frontend Engineer at Tidewater Health, Jan 2025 - Present
- Rebuilt the CarePortal appointment booking flow in React with server-rendered pages.
- Led a WCAG accessibility pass across the patient web app with screen reader testing on every release.
- Wrote the design-system components the patient web app and the clinic dashboard share.
- Moved the patient web app from client-side rendering to Next.js server rendering.
Senior Full-Stack Engineer at Northwind Logistics, Mar 2024 - Dec 2024
- Built TypeScript services on Node.js and PostgreSQL for shipment tracking.
- Designed event-driven workflows with queues, retries and webhooks on Cloudflare Workers.
- Tuned slow PostgreSQL queries behind the carrier dashboard and added the missing indexes.
- Reviewed code for a team of five engineers and wrote the team's deployment checklist.
Software Engineer at Bluefin Labs, Feb 2021 - Feb 2024
- Shipped React and Next.js interfaces used by warehouse operators every day.
- Wrote two internal Go services for label printing and stock counts.
- Built the Node.js API that the operator interfaces and the mobile scanners share.
- Ran the weekly on-call rotation and wrote incident reviews for the platform team.
Software Engineer at Quarry Systems, Jun 2018 - Jan 2021
- Built production web applications in TypeScript and React for construction clients.
- Wrote PostgreSQL schemas and migrations for the project scheduling product.
- Added end-to-end tests that ran on every pull request.
- Built the invoice export that construction clients used to send monthly statements.
- Moved the scheduling product's front end from jQuery to React and TypeScript, one screen at a time.
- Wrote the onboarding guide new engineers used in their first week.
`;

/**
 * The sample job rules: Sam lives in the Netherlands and works in English. Remote roles open
 * worldwide or to the Netherlands are kept; on-site roles elsewhere, other languages, interns
 * and roles that are not engineering are set aside before any model reads them.
 */
export const SAMPLE_RULES = {
	livesIn: "Netherlands",
	citizenship: ["Netherlands"],
	rightToWork: ["Netherlands"],
	keepRemoteFromHome: true,
	keepGlobalRemote: true,
	keepOnsiteIn: [],
	relocation: false,
	locationPrefilled: true,
	languages: ["English"],
	searchTitles: ["Senior Frontend Engineer", "Senior Full-Stack Engineer"],
};

/** A sample job as the sample source gives it. */
export interface SampleJob {
	id: string;
	title: string;
	company: string;
	locations: string[];
	workplaceType: "remote" | "hybrid" | "onsite";
	/** What the sample shows: kept and scored well, scored low, or set aside by a rule. */
	shows: "match" | "low-score" | "rule";
	description: string;
}

/** Eight fabricated postings: four matches, one that scores low, three that break a rule. */
export const SAMPLE_JOBS: SampleJob[] = [
	{
		id: "sample-1",
		title: "Senior Frontend Engineer",
		company: "Lumen Clinics",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		shows: "match",
		description: `Lumen Clinics runs booking and records software for small clinics. We are hiring a Senior Frontend Engineer for the patient web app.

What you will do
- Build the booking flow and the patient record views in React and Next.js.
- Own accessibility across the patient web app.
- Grow the design system the product teams share.

Requirements
- 5+ years building production web applications in TypeScript.
- Strong React and Next.js experience, including server rendering.
- Hands-on accessibility work (WCAG, screen readers).
- Experience with a design system used by several teams.
- Tailwind is a plus.

Location: fully remote, worldwide. We work in English.`,
	},
	{
		id: "sample-2",
		title: "Senior Full-Stack Engineer",
		company: "Kestrel Freight",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		shows: "match",
		description: `Kestrel Freight tracks shipments for mid-size carriers. We are hiring a Senior Full-Stack Engineer to own features from the database to the browser.

What you will do
- Build TypeScript services on Node.js and PostgreSQL.
- Ship React interfaces for dispatchers.
- Design event-driven workflows with queues and webhooks.

Requirements
- 6+ years building production systems in TypeScript.
- Node.js and PostgreSQL in production, including query tuning.
- React experience.
- Cloudflare Workers or another serverless platform is a plus.

Location: remote, worldwide. We work in English.`,
	},
	{
		id: "sample-3",
		title: "Frontend Engineer, Design Systems",
		company: "Orchid Studio",
		locations: ["Amsterdam, Netherlands"],
		workplaceType: "hybrid",
		shows: "match",
		description: `Orchid Studio makes planning tools for architects. We are hiring a Frontend Engineer to lead our design system, hybrid from our Amsterdam office.

What you will do
- Build and document shared React components.
- Work with designers on tokens, themes and accessibility.

Requirements
- 4+ years of frontend work in React and TypeScript.
- A design system you built or maintained.
- Accessibility experience.
- Storybook is a plus.

Location: hybrid, Amsterdam, Netherlands (two office days a week). We work in English.`,
	},
	{
		id: "sample-4",
		title: "Software Engineer, Platform",
		company: "Basalt Cloud",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		shows: "match",
		description: `Basalt Cloud hosts data pipelines for research teams. We are hiring a Software Engineer for the platform team.

What you will do
- Write Go and TypeScript services that run customer pipelines.
- Keep deploys safe and the on-call rotation calm.

Requirements
- 4+ years writing backend services in Go or TypeScript.
- Node.js experience.
- Kubernetes in production.
- Terraform is a plus.

Location: remote, worldwide. We work in English.`,
	},
	{
		id: "sample-5",
		title: "Senior Backend Engineer",
		company: "Fernwood Analytics",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		shows: "low-score",
		description: `Fernwood Analytics builds forecasting tools for retailers. We are hiring a Senior Backend Engineer for the data platform.

What you will do
- Build Python services and data jobs.
- Run the event streams the forecasts read.

Requirements
- 6+ years of Python in production.
- Django and Django REST Framework.
- Kafka or RabbitMQ.
- Scala or Java is a plus.
- Experience with Kubernetes and AWS.

Location: remote, worldwide. We work in English.`,
	},
	{
		id: "sample-6",
		title: "Software Engineering Intern",
		company: "Pebble Games",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		shows: "rule",
		description: `Pebble Games makes puzzle games for phones. Join us for a summer internship.

Requirements
- You are a student in computer science or a related field.
- Some TypeScript or Unity experience.

Location: remote, worldwide. We work in English.`,
	},
	{
		id: "sample-7",
		title: "Senior React Engineer",
		company: "Copperline Payments",
		locations: ["San Francisco, CA, United States"],
		workplaceType: "onsite",
		shows: "rule",
		description: `Copperline Payments builds checkout software. We are hiring a Senior React Engineer in our San Francisco office.

Requirements
- 5+ years of React and TypeScript.
- Payments experience is a plus.

Location: on-site in San Francisco, CA, United States. No visa sponsorship or relocation.`,
	},
	{
		id: "sample-8",
		title: "Account Executive",
		company: "Northgate Software",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		shows: "rule",
		description: `Northgate Software sells scheduling software to hospitals. We are hiring an Account Executive.

Requirements
- 3+ years closing B2B software deals.
- Experience selling to hospitals.

Location: remote, worldwide. We work in English.`,
	},
];
