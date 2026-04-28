#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps, draftOps, workerHeartbeatOps } from '../src/db/operations/index.js';
import { getConfig } from '../src/config/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import type { Draft, Image } from '../src/types/index.js';

const ARTIST_NAME = 'Tereza Costa Rêgo';
const SOURCE_DRAFT_ID = 77;

const READY_IMAGES: Image[] = [
  {
    url: 'https://lh3.googleusercontent.com/ci/AL18g_RUBwwsfF7Zs8hQKvqqQhKaMw010hN_04RemMUWuMazLJj094jrxD0ZDptyoYzs04P39mwVPdc=s1600',
    caption: 'Tereza Costa Rêgo - Ofélia do Capibaribe',
    attribution: 'Source: Google Arts & Culture.',
    provenance_context: 'MANUAL_OVERRIDE: artsandculture.google.com',
  },
  {
    url: 'https://bonifacio.net.br/wp-content/uploads/200728-Crian%C3%A7a-1392x1626.jpeg',
    caption: 'Tereza Costa Rêgo - Criança',
    attribution: 'Source: bonifacio.net.br.',
    provenance_context: 'MANUAL_OVERRIDE: bonifacio.net.br',
  },
  {
    url: 'http://marcozero.plank.com.br/wp-content/uploads/2023/06/DN010422002.jpg',
    caption: 'Tereza Costa Rêgo - historical painting',
    attribution: 'Source: galeriamarcozero.com.',
    provenance_context: 'MANUAL_OVERRIDE: galeriamarcozero.com',
  },
];

async function main(): Promise<void> {
  initDatabase();

  const artist = await artistOps.findByNormalizedName(ARTIST_NAME);
  if (!artist?.id) {
    throw new Error(`Artist not found: ${ARTIST_NAME}`);
  }

  const sourceDraft = await draftOps.findById(SOURCE_DRAFT_ID);
  if (!sourceDraft?.id) {
    throw new Error(`Source draft not found: ${SOURCE_DRAFT_ID}`);
  }

  const replacementDraft: Omit<Draft, 'id'> = {
    artist_id: artist.id,
    title: sourceDraft.title,
    subtitle: sourceDraft.subtitle,
    content: sourceDraft.content,
    status: 'ready',
    priority: 1000,
    last_heartbeat: new Date().toISOString(),
  };

  await artistOps.mergeMetadata(artist.id, {
    force_external_sources: true,
    manual_replacement: true,
  });

  const draftId = await draftOps.create(replacementDraft, READY_IMAGES);
  await draftOps.updateImages(draftId, READY_IMAGES);
  await draftOps.updateStatus(draftId, 'ready');
  await workerHeartbeatOps.touch('dispatcher', `manual-tereza-replacement:draft:${draftId}`);

  const email = new EmailModule(getConfig().env.resendApiKey);
  const emailId = await email.sendApprovalEmail({
    draftId,
    images: READY_IMAGES,
    bypassDailyCap: true,
  });

  console.log(
    JSON.stringify(
      {
        sent: true,
        draftId,
        artistId: artist.id,
        artistName: artist.full_name,
        emailId,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          sent: false,
          reason: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
