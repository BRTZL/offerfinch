import { describe, expect, it } from "vitest";

import {
	checkJobLink,
	checkResolvedHost,
	isPrivateAddress,
	routeJobLink,
} from "../src/sources/link";

const ok = (input: string) => {
	const r = checkJobLink(input);
	if (!r.ok) throw new Error(r.reason);
	return r.url;
};

describe("a job link the user pastes", () => {
	it("takes public http(s) links, adding https when the scheme is left out", () => {
		expect(
			ok("https://jobs.lever.co/acme/0f6a2c1e-1b2c-4d5e-8f90-123456789abc")
				.hostname,
		).toBe("jobs.lever.co");
		expect(ok("  careers.harbor-mills.example/jobs/42 ").protocol).toBe(
			"https:",
		);
	});

	it("refuses other schemes, credentials and hosts without a public name", () => {
		for (const [input, reason] of [
			["", /Paste a link/],
			["not a link at all", /no public host|not a link/],
			["file:///etc/passwd", /Only http and https/],
			["javascript:alert(1)", /Only http and https/],
			["ftp://example.com/job", /Only http and https/],
			["https://user:secret@example.com/job", /user name or password/],
			["http://intranet/jobs", /no public host/],
		] as const) {
			const r = checkJobLink(input);
			expect(r.ok, input).toBe(false);
			if (!r.ok) expect(r.reason, input).toMatch(reason);
		}
	});

	it("refuses this Mac and private networks in every spelling (no SSRF)", () => {
		for (const input of [
			"http://localhost:3000/job",
			"http://LOCALHOST./job",
			"http://printer.local/job",
			"http://wiki.corp/job",
			"http://127.0.0.1/job",
			"http://127.1/job",
			"http://2130706433/job",
			"http://0x7f000001/job",
			"http://0177.0.0.1/job",
			"http://0.0.0.0/job",
			"http://10.1.2.3/job",
			"http://172.16.5.4/job",
			"http://192.168.1.10/job",
			"http://169.254.169.254/latest/meta-data",
			"http://100.64.0.1/job",
			"http://[::1]/job",
			"http://[::ffff:127.0.0.1]/job",
			"http://[fd12:3456::1]/job",
			"http://[fe80::1]/job",
		]) {
			const r = checkJobLink(input);
			expect(r.ok, input).toBe(false);
			if (!r.ok) expect(r.reason, input).toMatch(/private network|public host/);
		}
	});

	it("knows private and public addresses", () => {
		expect(isPrivateAddress("8.8.8.8")).toBe(false);
		expect(isPrivateAddress("172.32.0.1")).toBe(false);
		expect(isPrivateAddress("2606:4700::1")).toBe(false);
		expect(isPrivateAddress("172.31.255.255")).toBe(true);
		expect(isPrivateAddress("::ffff:a00:1")).toBe(true);
	});

	it("refuses a public name that resolves to a private address", async () => {
		const lookup = async (host: string) =>
			({ "rebind.example": ["10.0.0.5"], "jobs.example": ["93.184.216.34"] })[
				host
			] ?? Promise.reject(new Error("ENOTFOUND"));
		expect(await checkResolvedHost("rebind.example", lookup)).toEqual({
			ok: false,
			reason: expect.stringMatching(/private network/),
		});
		expect(await checkResolvedHost("jobs.example", lookup)).toBeNull();
		expect(await checkResolvedHost("gone.example", lookup)).toEqual({
			ok: false,
			reason: expect.stringMatching(/could not be found/),
		});
	});
});

describe("how a link is read", () => {
	it("routes board postings to the boards' public data", () => {
		expect(
			routeJobLink(ok("https://boards.greenhouse.io/acme/jobs/4001")),
		).toMatchObject({
			kind: "board",
			posting: { board: "greenhouse", companyKey: "acme", jobId: "4001" },
		});
		expect(
			routeJobLink(
				ok(
					"https://jobs.ashbyhq.com/acme/9e8d7c6b-5a49-4382-9170-fedcba987654",
				),
			).kind,
		).toBe("board");
	});

	it("routes LinkedIn, Indeed and Glassdoor job links to their read-only readers", () => {
		expect(
			routeJobLink(
				ok(
					"https://www.linkedin.com/jobs/view/frontend-engineer-at-acme-3987654321/",
				),
			),
		).toEqual({
			kind: "linkedin",
			jobId: "3987654321",
		});
		expect(
			routeJobLink(
				ok("https://www.linkedin.com/jobs/search/?currentJobId=3987654321"),
			),
		).toEqual({
			kind: "linkedin",
			jobId: "3987654321",
		});
		expect(
			routeJobLink(
				ok("https://uk.indeed.com/viewjob?jk=a1b2c3d4e5f60718&from=serp"),
			),
		).toEqual({
			kind: "indeed",
			jobId: "a1b2c3d4e5f60718",
		});
		expect(
			routeJobLink(
				ok("https://www.glassdoor.com/job-listing/index.htm?jl=1009876543210"),
			),
		).toEqual({
			kind: "glassdoor",
			jobId: "1009876543210",
		});
	});

	it("reads any other page itself, a site's non-job page included", () => {
		expect(
			routeJobLink(ok("https://careers.harbor-mills.example/jobs/frontend")),
		).toEqual({
			kind: "page",
		});
		expect(routeJobLink(ok("https://www.linkedin.com/company/acme"))).toEqual({
			kind: "page",
		});
	});
});
