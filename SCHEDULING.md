# CASCA Editorial Agent - Scheduling Setup

This document explains how to set up automatic daily execution of the CASCA Editorial Agent on macOS.

## Overview

The CASCA Editorial Agent retries **every hour** until it successfully sends **one article per local day** to:
1. Check for verified artists
2. Generate article drafts using Claude
3. Source images
4. Send approval emails to the editor

## Installation

### Quick Install

Run the installation script:

```bash
./scripts/install-cron.sh
```

This will:
- Create necessary log directories
- Install a macOS launchd agent
- Configure it to retry hourly until one daily article is sent
- Load and activate the scheduler

### What Gets Installed

The script installs a launchd agent at:
```
~/Library/LaunchAgents/com.casca.daily-workflow.plist
```

This agent runs the wrapper script:
```
scripts/run-daily-wrapper.sh
```

Which executes:
```
npm run daily
```

## Verification

### Check if the agent is loaded

```bash
launchctl list | grep casca
```

You should see: `com.casca.daily-workflow`

### Check the current scheduler state

```bash
launchctl print gui/$(id -u)/com.casca.daily-workflow
```

### View logs

Daily execution logs:
```bash
tail -f logs/daily/$(date +%Y-%m-%d).log
```

Launchd output:
```bash
tail -f logs/launchd-stdout.log
tail -f logs/launchd-stderr.log
```

## Manual Execution

### Run normally (will send email if conditions are met)

```bash
npm run daily
```

### Dry run (no emails sent, just testing)

```bash
npm run daily -- --dry-run
```

### Force run (bypass "already sent today" check)

```bash
npm run daily -- --force
```

### Skip discovery (only process already verified artists)

```bash
npm run daily -- --skip-discovery
```

## Management Commands

### Reload the agent (after making changes)

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.casca.daily-workflow.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.casca.daily-workflow.plist
```

### Temporarily disable

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.casca.daily-workflow.plist
```

### Re-enable

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.casca.daily-workflow.plist
```

### Completely uninstall

```bash
./scripts/uninstall-cron.sh
```

## Changing the Schedule

To change when the script runs, edit `com.casca.daily-workflow.plist`:

```xml
<key>StartInterval</key>
<integer>3600</integer>
```

`3600` means "retry every 60 minutes". The workflow itself prevents duplicate same-day sends.

After editing, reload the agent:
```bash
./scripts/install-cron.sh
```

## Troubleshooting

### Agent not running

1. Check if it's loaded:
   ```bash
   launchctl list | grep casca
   ```

2. Check launchd logs for errors:
   ```bash
   cat logs/launchd-stderr.log
   ```

3. Try manual execution to see if the script works:
   ```bash
   ./scripts/run-daily-wrapper.sh
   ```

### Environment issues

If the script can't find Node or npm:

1. Edit `scripts/run-daily-wrapper.sh`
2. Update the `PATH` variable with your Node installation path
3. Reinstall: `./scripts/install-cron.sh`

### Permission issues

Ensure scripts are executable:
```bash
chmod +x scripts/*.sh
```

## Logs Location

All logs are stored in the `logs/` directory:

- `logs/daily/YYYY-MM-DD.log` - Daily execution logs (one per day)
- `logs/launchd-stdout.log` - Standard output from launchd
- `logs/launchd-stderr.log` - Error output from launchd

These files are gitignored and only exist locally.

## How It Works

```
launchd (macOS system)
  ↓ (runs hourly)
com.casca.daily-workflow.plist
  ↓ (executes)
scripts/run-daily-wrapper.sh
  ↓ (sets up environment, runs)
npm run daily
  ↓ (executes)
scripts/run-daily.ts
  ↓ (orchestrates)
WorkflowOrchestrator
  ↓ (discovery → synthesis → email)
```

## Testing Before Deployment

Always test before relying on automated execution:

```bash
# Test in dry-run mode (no side effects)
npm run daily -- --dry-run

# Check that it creates proper logs
ls -la logs/daily/

# Verify email module works (if you have a test artist)
npm run daily -- --force
```

## Notes

- The script retries hourly until one email is sent for the local day
- If an email was already sent today, it will skip execution and exit successfully
- Use `--force` flag to override this behavior during testing
- The launchd agent runs as your user, so it has access to your environment
- Keep the runner outside `Documents` to avoid macOS privacy restrictions
- Make sure the Mac Mini doesn't sleep (or wake it for scheduled tasks in System Settings)
