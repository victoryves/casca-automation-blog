# CASCA Editorial Agent

An automated editorial discovery and publishing assistant for CASCA Archive. This system identifies, verifies, and editorializes stories of visual artists from Northeast Brazil, producing Medium-style articles in English with strict human-in-the-loop editorial control.

## Authoritative Documentation

The operational source of truth for the current system is:

- [docs/SYSTEM_RUNBOOK.md](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/docs/SYSTEM_RUNBOOK.md)

Older documents in this repository are useful as historical context, but some of them no longer reflect the live behavior of the system.

## Key Principle

**Nothing publishes automatically.** All articles require explicit email approval before publication.

## Current Operating Model

- The system mines artists and sources continuously enough to maintain a backlog target of 5 approval-ready pending drafts.
- A draft is only considered ready when it has:
  - an English article with the required editorial structure
  - a title containing the artist name
  - at least 3 approval-ready artwork images
  - a non-published artist
- Rejection is supposed to trigger immediate replacement from the ready queue first, then continued replenishment in the background.
- Name-first discovery now merges the built-in curated seed list with an optional external curated artist file.
- By default, if present, the system automatically ingests `/Users/victoryves/Downloads/artistas_nordeste_expandido.txt`.
- Already-published artists are filtered out before those curated names enter discovery.
- The system now supports a persistent pre-mining cache at `data/artist-research-cache.json` so strong artist candidates can be researched before synthesis.
- Each cache entry stores:
  - biography sources
  - 3 to 5 candidate artwork URLs
  - repetition status against local history and external publication history

## Features

- 🔍 **Automated Discovery**: Uses Tavily plus source enrichment to find visual artists from Northeast Brazil
- ✅ **Source Verification**: Validates information against trusted institutional and museum-style sources
- ✍️ **AI-Powered Writing**: Generates English articles with Gemini under editorial constraints
- 🖼️ **Robust Image Sourcing**: Uses a dedicated Google Images stage plus Bing/DDG fallback and strict artwork validation
- 📧 **Email Approval**: Sends article previews for human approval only
- 🚀 **One-Click Publishing**: Approval is still required before anything reaches the blog

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Database**: SQLite (better-sqlite3)
- **AI**: Google Gemini
- **Email**: Resend (sending + inbound parsing)
- **Search**: Tavily API + multi-backend scraping
- **Scraping**: Firecrawl, Scrapling, Goose3, Crawl4AI, and a dedicated Google Images search stage with Bing/DDG fallback
- **Deployment**: Vercel (webhooks) + scheduled runner

## Project Structure

```
casca-automation-blog/
├── src/
│   ├── modules/          # Feature modules
│   ├── db/               # Database layer
│   ├── orchestrator/     # Workflow coordination
│   ├── config/           # Configuration management
│   └── types/            # TypeScript definitions
├── config/               # Configuration files
├── api/                  # Vercel serverless functions
├── scripts/              # Execution scripts
├── data/                 # Runtime data (gitignored)
└── logs/                 # Application logs (gitignored)
```

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Initialize database**:
   ```bash
   npm run daily -- --init
   ```

4. **Run development server**:
   ```bash
   npm run dev
   ```

## Usage

### Daily Execution

Run the daily workflow manually:

```bash
npm run daily
```

Pre-mine the prioritized shortlist into the persistent research cache:

```bash
npm run pre-mine-shortlist -- --limit 20
```

The continuous wrapper also runs shortlist pre-mining automatically before each send/replenishment cycle, and the editorial backlog target is 50 ready drafts while the system keeps mining at least 5 new approval-ready drafts per day.

Dashboard:

```bash
npm run webhooks
```

Then open:

- `/dashboard` for the live HTML dashboard
- `/api/dashboard` for the raw JSON snapshot
- the dashboard also shows two continuous worker health cards:
- `research miner` for cumulative reliable-artist mining
- `draft hydrator` for 100% draft preparation plus the daily 5am send

## Continuous Mining Architecture

The production flow now runs as two parallel, continuous workers:

- [scripts/run-research-miner.sh](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-research-miner.sh)
  grows the reliable-artist cache 24/7.
- [scripts/run-draft-hydrator.sh](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-draft-hydrator.sh)
  keeps turning reliable artists into fully-ready drafts 24/7, now in `cache-only` mode so it only consumes artists that already passed the research-cache funnel, and handles the 05:00 local approval email.

On macOS these are supervised with:

- [com.casca.daily-workflow.plist](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/com.casca.daily-workflow.plist)
- [com.casca.research-miner.plist](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/com.casca.research-miner.plist)

Reliability notes:

- `SERPAPI_API_KEY` can be configured to make Google Images sourcing much more reliable than raw scraping alone
- `scripts/run-daily.ts` now uses a heartbeat lock plus max-age expiry so hung workflow processes do not block the queue forever

Schedule with OpenClaw (Mac Mini):

```bash
# Add to crontab
0 9 * * * cd /path/to/casca-automation-blog && npm run daily
```

### Approval Flow

1. System sends email with article preview
2. Review the content in your inbox
3. Reply with the exact word **"poste"** to publish
4. Article is formatted and sent to Medium

### Configuration

Edit files in `config/` directory:

- `institutions.json` - Trusted source domains
- `prompts.json` - Claude article generation prompts
- `search-queries.json` - Tavily search templates
- `email-templates/` - HTML email layouts

## Development

### Type Checking

```bash
npm run type-check
```

### Linting

```bash
npm run lint
```

### Formatting

```bash
npm run format
```

### Building

```bash
npm run build
```

## Deployment

### Webhook Setup (Vercel)

1. Deploy webhook endpoint:
   ```bash
   vercel deploy
   ```

2. Configure Resend webhook:
   - URL: `https://your-domain.vercel.app/api/webhook/email`
   - Events: `email.received`

3. Set environment variables in Vercel dashboard

### Scheduling

Configure daily execution for 5 AM in the app timezone:

```bash
# Example cron
cron: "0 5 * * *"
command: "cd /path/to/casca-automation-blog && npm run daily"
timezone: "America/Toronto"
```

## Workflow

1. **Discovery**: Search for artists from Northeast Brazil
2. **Source Enrichment**: Expand trusted artist sources via Firecrawl/Scrapling/Goose/Crawl4AI
3. **Verification**: Validate candidate eligibility
4. **Synthesis**: Generate article using Gemini
5. **Editorial Gate**: Reject weak drafts before they enter the queue
6. **Visual**: Source only artwork images through the dedicated Google/Bing/DDG pipeline and vision validation
7. **Email**: Send approval request to editor only when the draft is truly ready
8. **Approval**: Wait for explicit approval
9. **Publishing**: Publish only after approval

## Database Schema

- `artists` - Artist biographical data
- `sources` - Credibility-scored source links
- `drafts` - Generated articles awaiting approval
- `publishing_log` - Publication history and errors

## Error Handling

- All errors logged to `logs/errors/`
- Failed API calls retry with exponential backoff
- Publishing failures preserve drafts
- No silent failures - all issues logged

## License

MIT
