#!/usr/bin/env tsx

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';
import { artistOps, sourceOps } from '../src/db/operations/index.js';
import { SynthesisModule } from '../src/modules/synthesis/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import type { Image } from '../src/types/index.js';

const config = loadConfig();

const IMAGES: Image[] = [
  {
    url: 'https://www.escritoriodearte.com/quadro/cicero-dias-lembrancas-oleo-sobre-tela-24867g.webp',
    caption: 'Lembranças, oil on canvas.',
    attribution: 'Escritorio de Arte.',
  },
  {
    url: 'https://www.escritoriodearte.com/quadro/cicero-dias-sonhos-liricos-nanquim-e-giz-de-cera-sobre-papel-24864g.webp',
    caption: 'Sonhos Líricos, ink and wax crayon on paper.',
    attribution: 'Escritorio de Arte.',
  },
  {
    url: 'https://www.escritoriodearte.com/quadro/cicero-dias-nu-feminino-com-flores-guache-sobre-papel-24865g.webp',
    caption: 'Nu Feminino Com Flores, gouache on paper.',
    attribution: 'Escritorio de Arte.',
  },
];

async function ensureArtist(): Promise<number> {
  const existing = await artistOps.findByNameAndCity('Cícero Dias', 'Escada');
  if (existing?.id) {
    if (existing.status !== 'verified') {
      await artistOps.updateStatus(existing.id, 'verified');
    }
    return existing.id;
  }

  return artistOps.create({
    full_name: 'Cícero Dias',
    birthplace_city: 'Escada',
    birthplace_state: 'Pernambuco',
    visual_practice: 'painting',
    status: 'verified',
    metadata: JSON.stringify({
      note: 'Manual daily recovery send with verified Escritorio de Arte sources.',
    }),
  });
}

async function ensureSources(artistId: number): Promise<void> {
  const sources = [
    {
      url: 'https://www.escritoriodearte.com/artista/cicero-dias',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Cícero Dias (Escada, Pernambuco, 1907 - Paris, 2003) was a painter, printmaker, draftsman, illustrator, set designer, and teacher, recognized as a central figure in Brazilian modern art. He collaborated with the Revista de Antropofagia, exhibited the landmark panel Eu Vi o Mundo..., worked between Recife, Rio, Lisbon, and Paris, and developed both figurative and lyrical abstract phases tied to Northeastern memory and color.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/cicero-dias/lembrancas-24867',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Lembranças by Cícero Dias, oil on canvas.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/cicero-dias/sonhos-liricos-24864',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Sonhos Líricos by Cícero Dias, ink and wax crayon on paper.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/cicero-dias/nu-feminino-com-flores-24865',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Nu Feminino Com Flores by Cícero Dias, gouache on paper.',
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

    console.log(`✅ Cícero Dias article sent with draft ${synthesisResult.draft.id}`);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('❌ Failed to send Cícero Dias article:', error);
  closeDatabase();
  process.exit(1);
});
