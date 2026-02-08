# Deployment Guide

Complete guide for deploying the CASCA Editorial Agent.

## Prerequisites

- Node.js 20+
- npm
- Accounts:
  - Anthropic (Claude API)
  - Resend (Email)
  - Tavily (Search)
  - Vercel (Webhooks)
  - Medium (Optional - for publishing)

## Initial Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and fill in all required values:

```bash
# Required
DATABASE_PATH=./data/casca.db
ANTHROPIC_API_KEY=sk-ant-xxxxx
RESEND_API_KEY=re_xxxxx
TAVILY_API_KEY=tvly-xxxxx
APPROVAL_EMAIL=your-email@domain.com
FROM_EMAIL=noreply@your-verified-domain.com
MEDIUM_AUTHOR_NAME=CASCA Archive
WEBHOOK_SECRET=generate-random-secret-here

# Optional
MEDIUM_IMPORT_EMAIL=your-medium-import@medium.com
WIKIMEDIA_API_KEY=
LOG_LEVEL=info
```

### 3. Verify Configuration Files

Ensure these config files are properly set up:

- `config/institutions.json` - Trusted institutional domains
- `config/prompts.json` - Claude article generation prompts
- `config/search-queries.json` - Tavily search templates

## Resend Setup

### 1. Create Account

1. Sign up at [resend.com](https://resend.com)
2. Verify your domain (required for sending)
3. Generate API key

### 2. Configure Inbound Email

1. Go to **Domains** in Resend dashboard
2. Select your domain
3. Enable **Inbound** email
4. Configure MX records (Resend provides these)
5. Set up webhook for inbound emails (see Vercel setup below)

## Vercel Deployment

### 1. Install Vercel CLI

```bash
npm i -g vercel
```

### 2. Login to Vercel

```bash
vercel login
```

### 3. Deploy

```bash
vercel
```

Follow the prompts to deploy. This creates a webhook endpoint at:
```
https://your-project.vercel.app/api/webhook/email
```

### 4. Configure Environment Variables

In Vercel dashboard, add all environment variables from `.env`:

```bash
# Via CLI
vercel env add DATABASE_PATH
vercel env add ANTHROPIC_API_KEY
vercel env add RESEND_API_KEY
# ... etc
```

Or use the Vercel dashboard UI.

### 5. Configure Resend Webhook

1. In Resend dashboard, go to **Webhooks**
2. Click **Add Endpoint**
3. URL: `https://your-project.vercel.app/api/webhook/email`
4. Events: Select `email.received`
5. Headers:
   - `Authorization`: `Bearer YOUR_WEBHOOK_SECRET`

## OpenClaw (Mac Mini Scheduling)

### 1. Install OpenClaw

```bash
# Installation method depends on your setup
brew install openclaw
# OR
# Follow OpenClaw installation instructions
```

### 2. Create OpenClaw Configuration

Create `openclaw.yml` in project root:

```yaml
name: casca-editorial-agent
schedule: "0 9 * * *"  # 9 AM daily
timezone: America/Recife
command: |
  cd /path/to/casca-automation-blog
  npm run daily
on_failure:
  retry: 3
  backoff: exponential
notifications:
  email: your-email@domain.com
```

### 3. Register Task

```bash
openclaw register openclaw.yml
```

### 4. Verify

```bash
openclaw status casca-editorial-agent
```

## Alternative: Cron Setup

If not using OpenClaw, use cron:

```bash
# Edit crontab
crontab -e

# Add daily execution at 9 AM
0 9 * * * cd /path/to/casca-automation-blog && npm run daily >> logs/daily/cron-$(date +\%Y-\%m-\%d).log 2>&1
```

## Database Initialization

Initialize the database before first run:

```bash
npm run daily -- --dry-run
```

This creates the SQLite database and tables.

## Testing

### Dry Run

Test the workflow without sending emails:

```bash
npm run daily -- --dry-run
```

### Force Run

Force execution even if email already sent today:

```bash
npm run daily -- --force
```

### Skip Discovery

Process only verified artists, skip discovery:

```bash
npm run daily -- --skip-discovery
```

## Monitoring

### Logs

Logs are written to:
- `logs/daily/YYYY-MM-DD.log` - Daily execution logs
- `logs/errors/YYYY-MM-DD.log` - Error logs only

### Database

Inspect database:

```bash
sqlite3 data/casca.db

# Check artists
SELECT * FROM artists ORDER BY discovered_at DESC LIMIT 10;

# Check drafts
SELECT * FROM drafts ORDER BY created_at DESC LIMIT 5;

# Check publishing log
SELECT * FROM publishing_log ORDER BY published_at DESC LIMIT 5;
```

## Troubleshooting

### Email Not Sending

1. Verify Resend domain is verified
2. Check `FROM_EMAIL` matches verified domain
3. Review Resend dashboard for delivery status
4. Check logs: `logs/errors/`

### Webhook Not Triggering

1. Verify webhook URL is correct
2. Check webhook secret matches
3. Test webhook in Resend dashboard
4. Check Vercel function logs

### No Artists Discovered

1. Verify Tavily API key is valid
2. Check search queries in `config/search-queries.json`
3. Review institutional whitelist in `config/institutions.json`
4. Check logs for API errors

### Database Errors

1. Ensure database directory exists: `mkdir -p data`
2. Check file permissions
3. Verify SQLite is available: `sqlite3 --version`

## Production Checklist

- [ ] All API keys configured
- [ ] Resend domain verified
- [ ] Webhook endpoint deployed to Vercel
- [ ] Webhook configured in Resend
- [ ] OpenClaw/cron scheduled
- [ ] Database initialized
- [ ] Dry run executed successfully
- [ ] Approval email tested
- [ ] Logs directory created
- [ ] Institutional whitelist reviewed
- [ ] Article prompts customized

## Medium Publishing

### Option 1: Email Import (Recommended)

1. Get your Medium import email:
   - Go to Medium settings
   - Find email import address
2. Add to `.env`:
   ```
   MEDIUM_IMPORT_EMAIL=your-unique-id@medium.com
   ```

### Option 2: Manual

If not using email import:
1. System saves article locally
2. Copy article from approval email
3. Publish manually on Medium
4. Update database with Medium URL:
   ```bash
   sqlite3 data/casca.db
   UPDATE publishing_log SET medium_url = 'https://medium.com/...' WHERE draft_id = X;
   ```

## Security Notes

- Never commit `.env` file
- Rotate webhook secret regularly
- Use Vercel environment variables for secrets
- Restrict database file permissions: `chmod 600 data/casca.db`
- Monitor Resend webhook signature verification
- Review logs for suspicious activity

## Scaling Considerations

Current setup supports:
- ~30 artists/month (1 per day)
- SQLite handles 1000s of records easily
- Vercel free tier sufficient for webhooks
- Resend free tier: 100 emails/day

For scaling:
- Consider PostgreSQL for database
- Implement rate limiting on webhook
- Add queue system for publishing
- Monitor API quota usage

## Support

For issues:
1. Check logs in `logs/`
2. Review GitHub issues
3. Contact: [your-support-email]
