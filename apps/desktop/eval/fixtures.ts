import {
	type ProfileRecord,
	type RecordInput,
	renderRecords,
} from "@offerfinch/core/profile/records";
import type { ProfileSnapshot } from "@offerfinch/core/profile/types";
import type { TailorJob } from "@offerfinch/core/tailor/tailor";

/**
 * A fabricated candidate and four fabricated postings for the tailoring eval. Every person,
 * employer and number here is invented; the email is example.com and the phone a 555 number.
 */

const DATE = new Date("2026-10-01T00:00:00Z");

const records: RecordInput[] = [
	{
		kind: "about",
		data: {
			name: "Noor Vandermeer",
			email: "noor.vandermeer@example.com",
			phone: "+31 555 0142 77",
			location: "Utrecht, Netherlands",
			linkedin: "linkedin.com/in/noor-vandermeer-example",
			website: "",
			github: "github.com/noorv-example",
			summary:
				"Software engineer with nine years of experience building web products, most recently payment flows and internal tooling in TypeScript and Node.js. Comfortable across React front ends, Node.js and Java back ends, and PostgreSQL. Has mentored junior engineers and run a design system used by four product teams.",
			more: [
				"- **Work authorization:** EU citizen (Dutch passport); no sponsorship needed anywhere in the EU.",
				"- **Notice period:** one month from signing an offer.",
				"- **Languages:** Dutch (native), English (fluent, daily working language since 2019), German (basic).",
				"- **Work setup:** open to remote or hybrid; can be in an Amsterdam or Utrecht office up to three days a week.",
			].join("\n"),
		},
	},
	...[
		"TypeScript",
		"JavaScript",
		"React",
		"Next.js",
		"Node.js",
		"Java",
		"Spring Boot",
		"PostgreSQL",
		"Redis",
		"GraphQL",
		"REST APIs",
		"Kafka",
		"Docker",
		"GitHub Actions",
		"AWS (ECS, S3, RDS)",
		"Storybook",
		"Playwright",
		"Jest",
		"Accessibility (WCAG 2.1 AA)",
	].map((name): RecordInput => ({ kind: "skill", data: { name } })),
	{
		kind: "experience",
		data: {
			company: "Harbourlight Payments",
			title: "Senior Software Engineer",
			location: "Amsterdam, Netherlands · Hybrid",
			start: "Mar 2022",
			end: "",
			bullets: [
				"Rebuilt the merchant checkout in React and TypeScript, cutting p95 page load from 3.1 s to 1.4 s and raising checkout completion by 6% over the following quarter.",
				"Designed and built an idempotent refunds service in Node.js and PostgreSQL that handles about 40,000 refunds a day without duplicate payouts.",
				"Moved card-payment events from nightly batch files to Kafka topics, so merchants see settled payments within two minutes instead of the next morning.",
				"Own the shared React component library (Storybook, 60+ components) used by four product teams; added accessibility tests that brought every component to WCAG 2.1 AA.",
				"Mentor two junior engineers and run the team's weekly code review session.",
				"Cut CI time for the main web repository from 22 to 9 minutes by splitting Playwright suites and caching builds in GitHub Actions.",
			],
			more: "",
		},
	},
	{
		kind: "experience",
		data: {
			company: "Kestrel & Finch Digital",
			title: "Software Engineer",
			location: "Rotterdam, Netherlands",
			start: "Jun 2019",
			end: "Feb 2022",
			bullets: [
				"Built client websites and web apps for 11 clients in retail, culture and the public sector, mostly in Next.js with headless CMSs (Contentful, Sanity).",
				"Led the front end of a ticketing site for a regional museum group that sold 120,000 tickets in its first year.",
				"Wrote GraphQL and REST APIs in Node.js for client integrations with booking and stock systems.",
				"Introduced Playwright end-to-end tests and a shared project template that cut new-project setup from about a week to two days.",
				"Presented technical options and estimates directly to clients in workshops.",
			],
			more: "",
		},
	},
	{
		kind: "experience",
		data: {
			company: "Graafland Verzekeringen",
			title: "Junior Java Developer",
			location: "Utrecht, Netherlands",
			start: "Sep 2017",
			end: "May 2019",
			bullets: [
				"Maintained Java 8 and Spring Boot services for insurance policy administration.",
				"Wrote batch jobs that reconciled policy payments against bank statements each night.",
				"Moved two internal services from an on-premise application server to Docker containers.",
			],
			more: "",
		},
	},
	{
		kind: "project",
		data: {
			name: "Tramtijd",
			description:
				"A small open-source PWA that shows live tram departures for Utrecht stops, built with Next.js and a public transit API.",
			bullets: [
				"About 900 weekly users, mostly from a local forum post.",
				"Works offline for saved stops with a service worker.",
			],
		},
	},
	{
		kind: "education",
		data: {
			school: "Hogeschool Utrecht",
			field: "Information Technology",
			years: "2013 – 2017",
			note: "",
		},
	},
	{
		kind: "extra",
		data: {
			title: "Talks and community",
			text: "- Gave a talk on testing design systems at a Utrecht frontend meetup (2024).\n- Volunteer coach at a local coding school for career changers since 2021.",
		},
	},
];

export const EVAL_PROFILE: ProfileSnapshot = {
	files: renderRecords(
		records.map(
			(r, index): ProfileRecord =>
				({
					...r,
					id: `eval-${r.kind}-${index}`,
					position: index,
					source: "eval fixture",
					sourceDate: DATE,
				}) as ProfileRecord,
		),
	),
};

export interface EvalPosting {
	slug: string;
	kind: string;
	job: TailorJob;
	/**
	 * Questions the posting's form asks, with words a correct first sentence must contain (any
	 * of them, case-insensitive). "why_us" also needs the company name or a posting detail.
	 */
	questions: { match: RegExp; expect: RegExp; label: string }[];
}

export const EVAL_POSTINGS: EvalPosting[] = [
	{
		slug: "lumenfold-frontend",
		kind: "senior frontend at a startup",
		job: {
			companyName: "Lumenfold",
			title: "Senior Frontend Engineer",
			url: "https://jobs.example.com/lumenfold/senior-frontend",
			locations: ["Remote - Europe"],
			workplaceType: "remote",
			descriptionText: `Lumenfold builds scheduling software for physiotherapy and small health clinics. Clinics use it to book patients, send reminders and take payments. We are 28 people, Series A, and our web app is used by 2,300 clinics in the Netherlands and Belgium.

About the role
You will be one of three frontend engineers. You will own our component library and work with our product designer to rebuild the booking calendar, the screen clinics use most. You will also help set frontend standards as we grow.

What you'll do
- Rebuild the booking calendar in React and TypeScript, with drag-and-drop and keyboard support
- Own and grow our design system in Storybook
- Improve performance on low-end clinic hardware
- Make the patient booking flow accessible (WCAG 2.1 AA)
- Review code and mentor a junior frontend engineer

What we look for
- 5+ years building web apps, with deep React and TypeScript
- Experience owning a design system or component library
- Care for accessibility and performance
- Clear written communication; we are remote-first across Europe

Nice to have
- Experience with payments in a web app
- Next.js

We offer a salary of EUR 75,000 to 90,000, stock options, and a yearly team week in Ghent.`,
		},
		questions: [],
	},
	{
		slug: "nordvik-backend",
		kind: "backend at a bank",
		job: {
			companyName: "Nordvik Bank",
			title: "Backend Engineer, Payments",
			url: "https://careers.example.com/nordvik/backend-payments",
			locations: ["Amsterdam, Netherlands"],
			workplaceType: "hybrid",
			descriptionText: `Nordvik Bank is a Dutch bank for small businesses, licensed by De Nederlandsche Bank. Our Payments team builds the systems that move money for 180,000 business customers: SEPA transfers, instant payments and card settlement.

The role
As a Backend Engineer in Payments you will design and run services that process payments reliably and in line with regulation. You will work in a team of six engineers, a product owner and a compliance partner. We work hybrid, with two days a week in our Amsterdam office.

Responsibilities
- Build and run Java and Kotlin services on Spring Boot
- Design event-driven flows on Kafka with exactly-once or idempotent processing
- Work with PostgreSQL at scale, including schema migrations without downtime
- Take part in the on-call rotation for payment services
- Write clear design documents and work with compliance on audit requirements

Requirements
- 4+ years of backend development, including Java
- Experience with payment systems or other systems where correctness matters
- Kafka or a similar event streaming platform
- PostgreSQL
- Right to work in the Netherlands

Nice to have
- Kotlin
- Knowledge of SEPA or ISO 20022
- Experience in a regulated environment`,
		},
		questions: [],
	},
	{
		slug: "parallax-fullstack",
		kind: "full-stack at an agency",
		job: {
			companyName: "Studio Parallax",
			title: "Full-Stack Developer",
			url: "https://studio-parallax.example.com/jobs/full-stack-developer",
			locations: ["Rotterdam, Netherlands"],
			workplaceType: "onsite",
			descriptionText: `Studio Parallax is a 40-person digital agency in Rotterdam. We design and build websites, e-commerce and web apps for cultural institutions, retailers and a few ambitious non-profits. Recent work includes the online collection of a maritime museum and a booking platform for a festival with 60,000 visitors.

What you'll do
- Build client projects end to end with Next.js, Node.js and headless CMSs
- Turn designs into fast, accessible front ends
- Build integrations with clients' booking, ticketing and stock systems
- Join client workshops to scope features and give estimates
- Keep our project starter kit and testing setup up to date

Who you are
- 3+ years as a full-stack or frontend-leaning developer
- Strong with React/Next.js and Node.js
- Experience with a headless CMS such as Sanity, Contentful or Storyblok
- Comfortable talking to clients without a project manager translating
- You care about craft: performance, accessibility, clean code

We work from our studio in Rotterdam four days a week. Dutch is a plus but not required.`,
		},
		questions: [],
	},
	{
		slug: "tallyway-platform",
		kind: "role with application questions",
		job: {
			companyName: "Tallyway",
			title: "Senior Software Engineer, Platform",
			url: "https://jobs.example.com/tallyway/senior-platform",
			locations: ["Remote - EU"],
			workplaceType: "remote",
			descriptionText: `Tallyway makes bookkeeping software for freelancers and small agencies in Europe. 35,000 customers send invoices, track expenses and file VAT returns with us. Our platform team of five keeps the core services, CI and developer tooling fast and reliable for the 30 engineers who build on them.

What you'll work on
- Our Node.js and TypeScript services and the PostgreSQL databases behind them
- Developer experience: CI pipelines, test infrastructure, preview environments
- Moving background jobs to an event-driven setup
- Observability and incident response

What we need
- 6+ years of software engineering, with recent work in TypeScript and Node.js
- Experience improving CI speed or developer tooling
- PostgreSQL in production
- AWS
- You write well; we are fully remote and async-first

Application questions
Please answer these in your application:
1. What is your notice period?
2. What are your salary expectations (gross per year, EUR)?
3. Why do you want to work at Tallyway?`,
		},
		questions: [
			{
				label: "notice period",
				match: /notice/i,
				expect: /\b(one|1)\s+month\b/i,
			},
			{
				label: "salary",
				match: /salary/i,
				expect:
					/(EUR|€|\bopen\b|discuss|not (?:stated|listed|recorded|given)|range|happy to)/i,
			},
			{
				label: "why us",
				match: /why .*(work|join).*tallyway|why tallyway/i,
				expect: /tallyway|bookkeep|freelancer|platform|CI|developer/i,
			},
		],
	},
];
