# CASCA Mac Mini PM2 Master Orchestrator

This is the 24/7 autonomous Mac Mini runtime.

## Install

```bash
cd "/Users/victoryves/Documents/personal/Vibe Coding/casca-automation-blog"
npm install
npm install node-cron
```

## Start Under PM2

```bash
pm2 start ecosystem.config.js
pm2 startup
```

After `pm2 startup`, copy and paste the exact command PM2 prints for macOS launchd.
Then persist the process list:

```bash
pm2 save
```

## Log Rotation

Install PM2 log rotation so the Mac Mini disk does not fill up over months of continuous mining:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 25M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 save
```

## Useful Commands

```bash
pm2 status
pm2 logs casca-master-orchestrator
pm2 restart casca-master-orchestrator
pm2 monit
```

## Runtime Behavior

- Miner loop: runs at boot, then every 2 hours.
- Replenish guard: runs `scripts/exa-replenish.ts` when researched targets fall below `MASTER_MIN_RESEARCHED_TARGETS` (`8` by default).
- Hydration guard: runs `scripts/autonomous-sentinel.ts --headless --force-high-res --hydrate-only` when the ready queue falls below `MASTER_MIN_READY_DRAFTS` (`3` by default).
- Daily dispatch: runs at `0 5 * * *` in `APP_TIMEZONE`, falling back to `America/Toronto`.
- Final send gate: `Dispatcher` blocks sends unless the draft has exactly 3 approval-ready images, passes the 450px image floor, passes text hygiene, and includes both `leg` and `anatomy`.
