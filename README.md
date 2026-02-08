# CASCA Editorial Agent

An automated editorial discovery and publishing assistant for CASCA Archive. This system identifies, verifies, and editorializes stories of visual artists from Northeast Brazil, producing Medium-style articles in English with strict human-in-the-loop editorial control.

## Key Principle

**Nothing publishes automatically.** All articles require explicit email approval before publication.

## Features

- 🔍 **Automated Discovery**: Uses Tavily API to find artists from Northeast Brazil
- ✅ **Source Verification**: Validates information against trusted institutional sources
- ✍️ **AI-Powered Writing**: Generates Medium-style articles using Claude
- 🖼️ **Image Sourcing**: Finds and attributes images from Wikimedia Commons
- 📧 **Email Approval**: Sends daily article previews for human approval
- 🚀 **One-Click Publishing**: Reply "poste" to publish to Medium

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Database**: SQLite (better-sqlite3)
- **AI**: Anthropic Claude
- **Email**: Resend (sending + inbound parsing)
- **Search**: Tavily API
- **Deployment**: Vercel (webhooks) + OpenClaw (scheduling)

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

### Scheduling (OpenClaw)

Configure daily execution at 9 AM BRT:

```bash
# OpenClaw configuration
*/
cron: "0 9 * * *"
command: "cd /path/to/casca-automation-blog && npm run daily"
timezone: "America/Recife"
```

## Workflow

1. **Discovery**: Search for artists from Northeast Brazil
2. **Verification**: Validate against trusted institutional sources
3. **Synthesis**: Generate article using Claude
4. **Visual**: Source images from Wikimedia Commons
5. **Email**: Send approval request to editor
6. **Approval**: Wait for "poste" reply
7. **Publishing**: Send formatted article to Medium

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
