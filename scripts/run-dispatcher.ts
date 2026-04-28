#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { getConfig } from '../src/config/index.js';
import { draftOps, publishingOps } from '../src/db/operations/index.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';

const DAILY_SEND_HOUR = 5;

function getLocalHour(timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '0';
  return Number(hourPart);
}

async function main(): Promise<void> {
  initDatabase();
  try {
    const config = getConfig();
    const timezone = config.env.appTimezone || 'UTC';
    const dispatcher = new Dispatcher(new EmailModule(config.env.resendApiKey));
    const outstandingSent = await draftOps.findOutstandingSent();
    const replacementLogs = (await publishingOps.findFailed()).filter(
      (log) => log.id && log.error_message === 'replacement_requested'
    );
    const force = process.argv.includes('--force');
    const afterSendHour = getLocalHour(timezone) >= DAILY_SEND_HOUR;

    if (outstandingSent && !force) {
      console.log(`Dispatcher idle: draft ${outstandingSent.id} is still awaiting approval.`);
      return;
    }

    if (replacementLogs.length > 0) {
      const nextDraft = await dispatcher.getNextReadyDraft();
      if (!nextDraft?.id) {
        console.log('Dispatcher replacement pass found no ready draft to select.');
        process.exit(2);
      }
      console.log(
        `Dispatcher selected replacement draft ${nextDraft.id} with priority ${nextDraft.priority ?? 0}: ${nextDraft.title}`
      );
      const result = await dispatcher.sendDraft(nextDraft.id, true);
      if (result.sent) {
        await publishingOps.delete(replacementLogs[0].id!);
        console.log(`Dispatcher replacement sent draft ${result.draftId} (${result.artistName ?? 'unknown artist'}).`);
        return;
      }
      console.log(`Dispatcher replacement pass did not send: ${result.reason ?? 'unknown reason'}`);
      process.exit(2);
    }

    if (!force && !afterSendHour) {
      console.log(`Dispatcher idle: local time has not reached ${DAILY_SEND_HOUR.toString().padStart(2, '0')}:00 yet.`);
      return;
    }

    const alreadySentToday = await draftOps.emailSentToday();
    if (alreadySentToday && !force) {
      console.log('Dispatcher idle: daily send already satisfied.');
      return;
    }

    const nextDraft = await dispatcher.getNextReadyDraft();
    if (!nextDraft?.id) {
      console.log('Dispatcher found nothing sendable: No READY draft available in dispatcher queue');
      process.exit(2);
    }

    console.log(
      `Dispatcher selected draft ${nextDraft.id} with priority ${nextDraft.priority ?? 0}: ${nextDraft.title}`
    );
    const result = await dispatcher.sendDraft(nextDraft.id, force);
    if (result.sent) {
      console.log(`Dispatcher sent draft ${result.draftId} (${result.artistName ?? 'unknown artist'}).`);
      return;
    }

    console.log(`Dispatcher found nothing sendable: ${result.reason ?? 'unknown reason'}`);
    process.exit(2);
  } finally {
    closeDatabase();
  }
}

void main();
