# CLAUDE.md

## Why You Are Reading This

You are being asked to review this repository and propose a robust multi-agent
architecture for the CASCA editorial automation system.

You are not being asked to write the production code directly.

The implementation will be done later with Codex in this repository.

Your job is to think like a systems architect and reliability engineer.

## What The Human Wants

The human wants a system that mines artists daily and reliably delivers one
approval email every day at 05:00 America/Toronto.

When the editor rejects a draft, the system should automatically send another
approval-ready draft almost immediately.

The backlog should be cumulative, not disposable.

The queue should stay comfortably above the minimum needed to guarantee daily send.

## What The System Already Has

This repository already contains:

- Workflow orchestration
- Discovery logic
- Verification logic
- Synthesis logic
- Visual/image validation logic
- Email generation and send flow
- Rejection webhook flow
- Publication history dedupe
- Dashboard
- Continuous miners supervised by launchd

This is not a greenfield design exercise. Your recommendations should be grounded
in the current repo structure and failure modes.

## What To Optimize For

Optimize for:

1. Reliability
2. Queue health
3. Fast rejection replacement
4. Strong image correctness
5. Strong duplicate protection
6. Strong source hygiene
7. Recovery from partial failures
8. Visibility and operational clarity

Do not optimize primarily for:

- novelty
- theoretical elegance
- maximum decentralization
- unnecessary complexity

## Real Failure Modes To Design Around

Please explicitly account for these:

1. No article sent on the daily schedule
2. Rejection does not trigger replacement
3. Discovery returns zero usable candidates
4. Search providers fail with 403 / timeout / ECONNRESET
5. Wrong artist images get attached
6. Portraits or photos of the artist get attached instead of artworks
7. Scraping junk contaminates source summaries and generated prose
8. Queue appears non-empty in DB but drafts are not truly sendable
9. Long-running workers get stuck, slowed, or degraded

## What Kind Of Answer Is Expected

Please provide:

1. Proposed agents and their responsibilities
2. Inputs and outputs for each agent
3. Shared state and queue design
4. Health checks, retries, and escalation rules
5. A minimal set of invariants that must always hold
6. How to prevent the "no email today" failure definitively
7. How to prevent the "rejected but no replacement arrived" failure definitively
8. A phased implementation plan that Codex can apply inside this repo

## Helpful Orientation

Read these files first:

- `README.md`
- `docs/SYSTEM_RUNBOOK.md`
- `SCHEDULING.md`
- `src/orchestrator/workflow.ts`
- `src/modules/discovery/index.ts`
- `src/modules/publication-history/index.ts`
- `src/modules/email/index.ts`
- `src/modules/visual/index.ts`
- `src/modules/dashboard/index.ts`
- `scripts/run-daily-wrapper.sh`
- `scripts/run-draft-hydrator.sh`
- `scripts/run-research-miner.sh`
- `scripts/webhook-server.ts`

## Final Reminder

The target outcome is simple:

- 5 good drafts mined per day
- cumulative backlog
- 1 approval email every day at 05:00 local time
- automatic replacement after rejection
- no bad images
- no duplicate artists
- no dirty text

Design the agent architecture that gives the highest chance of making that true.
