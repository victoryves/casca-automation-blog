#!/usr/bin/env tsx

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';
import { artistOps, draftOps, sourceOps } from '../src/db/operations/index.js';
import { SynthesisModule } from '../src/modules/synthesis/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import type { Image } from '../src/types/index.js';

const config = loadConfig();

const IMAGES: Image[] = [
  {
    url: 'https://www.escritoriodearte.com/quadro/reynaldo-fonseca-figura-feminina-oleo-sobre-cartao-pincel-seco-19379g.webp',
    caption: 'Figura Feminina (1980), oil on board, dry brush, 49 x 34 cm.',
    attribution: 'Escritorio de Arte.',
  },
  {
    url: 'https://www.escritoriodearte.com/quadro/reynaldo-fonseca-cortando-o-cabelo-oleo-sobre-tela-1766g.webp',
    caption: 'Cortando o Cabelo (2007), oil on canvas, 70 x 50 cm.',
    attribution: 'Escritorio de Arte.',
  },
  {
    url: 'https://www.escritoriodearte.com/quadro/reynaldo-fonseca-cesta-de-frutas-oleo-sobre-tela-1192g.webp',
    caption: 'Cesta de Frutas (2006), oil on canvas, 60 x 80 cm.',
    attribution: 'Escritorio de Arte.',
  },
];

async function ensureArtist(): Promise<number> {
  const existing = await artistOps.findByNameAndCity('Reynaldo Fonseca', 'Recife');
  if (existing?.id) {
    if (existing.status !== 'verified') {
      await artistOps.updateStatus(existing.id, 'verified');
    }
    return existing.id;
  }

  return artistOps.create({
    full_name: 'Reynaldo Fonseca',
    birthplace_city: 'Recife',
    birthplace_state: 'Pernambuco',
    visual_practice: 'painting',
    status: 'verified',
    metadata: JSON.stringify({
      note: 'Manual daily recovery send with verified biography and artwork pages from Escritorio de Arte.',
    }),
  });
}

async function ensureSources(artistId: number): Promise<void> {
  const sources = [
    {
      url: 'https://www.escritoriodearte.com/artista/reynaldo-fonseca',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Reynaldo Fonseca (Recife PE 1925 - 2019) was a painter, muralist, and illustrator. He attended the Escola de Belas Artes de Pernambuco, studied with Lula Cardoso Ayres and later with Candido Portinari in Rio de Janeiro, helped found the Sociedade de Arte Moderna do Recife, taught drawing at UFPE, and became known for figurative paintings marked by dreamlike, uncanny family scenes and refined draftsmanship.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/reynaldo-fonseca/figura-feminina-19379',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Figura Feminina by Reynaldo Fonseca, oil on board with dry brush, dated 1980, measuring 49 x 34 cm.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/reynaldo-fonseca/cortando-o-cabelo-1766',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Cortando o Cabelo by Reynaldo Fonseca, oil on canvas, dated 2007, measuring 70 x 50 cm.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/reynaldo-fonseca/cesta-de-frutas-1192',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Cesta de Frutas by Reynaldo Fonseca, oil on canvas, dated 2006, measuring 60 x 80 cm.',
    },
  ];

  for (const source of sources) {
    const exists = await sourceOps.exists(artistId, source.url);
    if (!exists) {
      await sourceOps.create({
        artist_id: artistId,
        ...source,
      });
    }
  }
}

async function main(): Promise<void> {
  initDatabase();

  try {
    const artistId = await ensureArtist();
    await ensureSources(artistId);

    const synthesis = new SynthesisModule(config.env.geminiApiKey);
    const email = new EmailModule(config.env.resendApiKey);

    const synthesisResult = await synthesis.synthesize(artistId);

    await email.sendApprovalEmail({
      draftId: synthesisResult.draft.id!,
      images: IMAGES,
    });

    console.log(`✅ Reynaldo Fonseca article sent with draft ${synthesisResult.draft.id}`);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('❌ Failed to send Reynaldo Fonseca article:', error);
  closeDatabase();
  process.exit(1);
});
