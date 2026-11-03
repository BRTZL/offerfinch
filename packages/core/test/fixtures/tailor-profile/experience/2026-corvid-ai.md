# Corvid AI — Senior Software Engineer

- **Dates:** Feb 2026 – Present
- **Location:** Remote · Contract

### Bullet variants used in CVs (verbatim)

- Main author of AFC (AI Film Compute), the studio's event-driven generation service: durable Cloudflare Workflows run job-specific Go containers against third-party AI providers, stream outputs to R2 and report every state change through signed webhooks. *(used in: Acme)*
- Made job intake and delivery safe to retry: idempotency keys on job requests, a Postgres transactional outbox drained with FOR UPDATE SKIP LOCKED, and webhook delivery through a queue with retries and a dead-letter queue. *(used in: Acme)*
- Designed its PostgreSQL data model (Drizzle, Hyperdrive) for job status, provider errors, cost per job and webhook delivery state, with a Next.js dashboard for debugging production jobs. *(used in: Acme)*
- Built DirectorAI's MCP server so AI agents can browse the style catalog and create and inspect generations, and its credits and billing: balances, purchases and subscriptions. *(used in: Acme)*
