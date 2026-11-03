// Fabricated data only: Sam Rivera and invented companies. Nothing here is a real person,
// employer or posting.

export type Status = "ready" | "answers" | "drafting" | "applied";

export type Job = {
	id: string;
	company: string;
	role: string;
	fit: number;
	status: Status;
	when: string;
	board: string;
	questions?: number;
};

export const JOBS: Job[] = [
	{
		id: "nimbus",
		company: "Nimbus Labs",
		role: "Frontend Engineer, Design System",
		fit: 94,
		status: "ready",
		when: "2h",
		board: "Greenhouse",
	},
	{
		id: "orbit",
		company: "Orbit Freight",
		role: "Senior Backend Engineer",
		fit: 91,
		status: "ready",
		when: "3h",
		board: "Ashby",
	},
	{
		id: "halcyon",
		company: "Halcyon Health",
		role: "Staff Product Engineer",
		fit: 88,
		status: "answers",
		when: "5h",
		board: "Lever",
		questions: 2,
	},
	{
		id: "juniper",
		company: "Juniper Maps",
		role: "Senior Frontend Engineer",
		fit: 86,
		status: "ready",
		when: "Yesterday",
		board: "Greenhouse",
	},
	{
		id: "tidepool",
		company: "Tidepool Audio",
		role: "Design Engineer",
		fit: 83,
		status: "drafting",
		when: "Yesterday",
		board: "Careers page",
	},
	{
		id: "kestrel",
		company: "Kestrel Bank",
		role: "Full-Stack Engineer, Payments",
		fit: 81,
		status: "ready",
		when: "Mon",
		board: "LinkedIn",
	},
	{
		id: "lumen",
		company: "Lumen Grid",
		role: "React Engineer",
		fit: 78,
		status: "answers",
		when: "Mon",
		board: "Ashby",
		questions: 1,
	},
	{
		id: "brightwater",
		company: "Brightwater Studio",
		role: "Senior UI Engineer",
		fit: 76,
		status: "applied",
		when: "Sun",
		board: "Lever",
	},
	{
		id: "fernhill",
		company: "Fernhill Robotics",
		role: "Frontend Engineer, Tools",
		fit: 74,
		status: "applied",
		when: "Sat",
		board: "Greenhouse",
	},
	{
		id: "quayside",
		company: "Quayside Energy",
		role: "Product Engineer",
		fit: 72,
		status: "applied",
		when: "Oct 28",
		board: "Ashby",
	},
	{
		id: "marlow",
		company: "Marlow Books",
		role: "Senior Frontend Engineer",
		fit: 71,
		status: "applied",
		when: "Oct 27",
		board: "LinkedIn",
	},
];

export const POSTINGS = {
	nimbus: {
		title: "Frontend Engineer, Design System",
		meta: ["Nimbus Labs", "Hybrid, Lisbon", "€72–88k", "Posted 2 days ago"],
		intro:
			"Nimbus Labs builds scheduling software used by 4,000 clinics. We are hiring a frontend engineer to own the design system that every team ships with.",
		sections: [
			{
				head: "What you will do",
				lines: [
					{
						text: "Build and document components in React and TypeScript",
						mark: "met",
					},
					{
						text: "Work with design on tokens, theming and dark mode",
						mark: "met",
					},
					{
						text: "Raise accessibility across the product to WCAG 2.2 AA",
						mark: "met",
					},
					{
						text: "Review pull requests and mentor two engineers",
						mark: "met",
					},
				],
			},
			{
				head: "What you bring",
				lines: [
					{ text: "5+ years building production frontends", mark: "met" },
					{
						text: "A design system you have shipped and maintained",
						mark: "met",
					},
					{ text: "Comfort with visual regression tests", mark: "met" },
					{ text: "Nice to have: Storybook", mark: "gap" },
				],
			},
		],
		extra: [
			{
				head: "How we work",
				text: "Three days a week in our Lisbon office near Cais do Sodré, the rest from home. Twenty-five days of leave and a learning budget.",
			},
			{
				head: "Interviews",
				text: "A call with the hiring manager, a pairing session on a real component, and a conversation with two designers. About two weeks end to end.",
			},
		],
	},
	orbit: {
		title: "Senior Backend Engineer",
		meta: ["Orbit Freight", "Remote, Europe", "€80–95k", "Posted today"],
		intro:
			"Orbit Freight moves 30,000 pallets a day across Europe. The platform team keeps shipment tracking, pricing and carrier integrations fast and correct.",
		sections: [
			{
				head: "What you will do",
				lines: [
					{
						text: "Design TypeScript services on Node.js and PostgreSQL",
						mark: "met",
					},
					{
						text: "Own event-driven workflows with queues and retries",
						mark: "met",
					},
					{ text: "Integrate carrier APIs and webhooks", mark: "met" },
				],
			},
			{
				head: "What you bring",
				lines: [
					{ text: "6+ years on backend systems in production", mark: "met" },
					{ text: "Experience with Kafka or a similar log", mark: "gap" },
				],
			},
		],
		extra: [
			{
				head: "How we work",
				text: "Remote across Europe, with core hours from 10:00 to 15:00 CET. The team meets in Rotterdam twice a year; travel is paid.",
			},
			{
				head: "On call",
				text: "One week in six, shared with five engineers. Pages are rare and paid at a fixed rate per week.",
			},
			{
				head: "Interviews",
				text: "A call with the engineering manager, a system design conversation about shipment tracking, and a review of code you have written. About ten days end to end.",
			},
		],
	},
} as const;

export const CV = {
	name: "Sam Rivera",
	contact:
		"sam.rivera@example.com · Ankara · linkedin.com/in/samrivera-example",
	summary:
		"Frontend engineer with eight years on React and TypeScript products, the last four building and running design systems used by several teams.",
	skills:
		"React, TypeScript, design tokens, accessibility (WCAG 2.2), visual regression testing, Node.js, PostgreSQL",
	roles: [
		{
			title: "Senior Frontend Engineer",
			org: "Tidewater Health",
			when: "Jan 2025 – now",
			bullets: [
				"Built the design-system components the patient app and the clinic dashboard share, with tokens for light and dark.",
				"Took 41 screens to WCAG 2.2 AA and added axe checks to every pull request.",
			],
		},
		{
			title: "Senior Full-Stack Engineer",
			org: "Northwind Logistics",
			when: "Mar 2022 – Dec 2024",
			bullets: [
				"Led the move of 60 components into a shared library with visual regression tests.",
				"Mentored three engineers through their first design-system releases.",
			],
		},
		{
			title: "Software Engineer",
			org: "Bluefin Labs",
			when: "Feb 2018 – Feb 2022",
			bullets: [
				"Shipped React interfaces used by warehouse operators every day.",
			],
		},
	],
};
