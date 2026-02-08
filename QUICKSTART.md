# Quick Start Guide

Get the CASCA Editorial Agent running in 5 minutes.

## Prerequisites

- Node.js 20+
- API Keys:
  - Anthropic (Claude)
  - Resend
  - Tavily

## 1. Install Dependencies

```bash
npm install
```

## 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```bash
DATABASE_PATH=./data/casca.db
ANTHROPIC_API_KEY=sk-ant-xxxxx
RESEND_API_KEY=re_xxxxx
TAVILY_API_KEY=tvly-xxxxx
APPROVAL_EMAIL=your-email@example.com
FROM_EMAIL=noreply@your-domain.com
MEDIUM_AUTHOR_NAME=CASCA Archive
WEBHOOK_SECRET=your-random-secret
LOG_LEVEL=info
```

## 3. Verify Configuration

```bash
npm run test-config
```

This validates all configuration files and environment variables.

## 4. Initialize Database

```bash
npm run init-db
```

Creates the SQLite database and tables.

## 5. Test Run (Dry Run)

```bash
npm run daily -- --dry-run
```

This executes the full workflow without sending emails. You'll see:
- Discovery of artists from search
- Verification of candidates
- Article synthesis with Claude
- Image sourcing from Wikimedia
- Email template generation

## 6. First Real Execution

Once you're ready to send your first email:

```bash
npm run daily
```

The system will:
1. Search for artists from Northeast Brazil
2. Verify eligibility
3. Generate an article with Claude
4. Source images
5. Send approval email to your inbox

## 7. Approve and Publish

When you receive the approval email:

1. Review the article
2. Reply with exactly: **poste**
3. The article will be published (or saved locally if Medium not configured)

## What's Next?

### Deploy Webhook (Optional)

To enable email approval, deploy the webhook to Vercel:

```bash
vercel deploy
```

Then configure the webhook in Resend dashboard to point to:
```
https://your-project.vercel.app/api/webhook/email
```

### Schedule Daily Execution

#### Option A: OpenClaw (Recommended for Mac Mini)

```yaml
# openclaw.yml
name: casca-editorial-agent
schedule: "0 9 * * *"  # 9 AM daily
timezone: America/Recife
command: |
  cd /path/to/casca-automation-blog
  npm run daily
```

```bash
openclaw register openclaw.yml
```

#### Option B: Cron

```bash
crontab -e

# Add:
0 9 * * * cd /path/to/casca-automation-blog && npm run daily
```

## Troubleshooting

### No Artists Found

- Check Tavily API key
- Review search queries in `config/search-queries.json`
- Verify institutional whitelist in `config/institutions.json`

### Email Not Sending

- Verify Resend domain is verified
- Check `FROM_EMAIL` matches verified domain
- Review logs in `logs/daily/`

### Webhook Not Working

- Verify webhook URL in Resend
- Check webhook secret matches `.env`
- Review Vercel function logs

## Useful Commands

```bash
# Test configuration
npm run test-config

# Initialize database
npm run init-db

# Dry run (no emails)
npm run daily -- --dry-run

# Force run (ignore daily limit)
npm run daily -- --force

# Skip discovery phase
npm run daily -- --skip-discovery

# Type checking
npm run type-check

# Linting
npm run lint

# Format code
npm run format
```

## Project Structure

```
casca-automation-blog/
├── src/modules/        # Feature modules
├── src/db/             # Database layer
├── src/orchestrator/   # Workflow coordination
├── config/             # Configuration files
├── api/                # Vercel webhook
├── scripts/            # Execution scripts
├── data/               # Database (created at runtime)
└── logs/               # Logs (created at runtime)
```

## Support

For detailed information:
- Full deployment guide: `DEPLOYMENT.md`
- Project status: `PROJECT_STATUS.md`
- Main documentation: `README.md`

## Security Notes

- Never commit `.env` file
- Keep API keys secure
- Use strong webhook secret
- Review logs for suspicious activity

---

**Ready to discover artists!** 🎨
