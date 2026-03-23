#!/usr/bin/env tsx

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/supabase.js';
import { artistOps, draftOps, publishingOps, sourceOps } from '../src/db/operations/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import type { Image } from '../src/types/index.js';

const config = loadConfig();

const ARTICLE = {
  title: 'Antonio Bandeira and the Pulse of Brazilian Abstraction',
  subtitle:
    'From Fortaleza to Paris, Bandeira transformed color, gesture, and urban rhythm into one of the strongest abstract languages in Brazilian painting.',
  content: `Antonio Bandeira belongs to that generation of Brazilian artists who did not treat abstraction as a formal trend imported from abroad, but as a living field of invention. Born in Fortaleza in 1922 and later active between Rio de Janeiro and Paris, he built a body of work in which painting seems to move before it settles. His canvases rarely feel static. Even when they are carefully structured, they carry the sensation of vibration, drift, and inner weather.

The biographical material gathered for this article shows how early Bandeira's commitment to art took shape. In Ceará, he participated in the formation of the Centro Cultural de Belas Artes, which later became the Sociedade Cearense de Belas Artes, helping establish a local artistic scene while still very young. That starting point matters because it places him not at the edge of Brazilian modernism, but inside one of its regional engines. He was already part of a network of artists and critics thinking seriously about painting before his move to the major national and international centers.

One statement attributed to Bandeira is especially revealing: “I never paint pictures. I try to make painting.” It is a compact sentence, but it clarifies almost everything about his work. The point was not illustration, anecdote, or a stable motif. The point was painting itself: surface, gesture, density, rhythm, and the open continuity from one canvas to the next. That attitude helps explain why his work still feels alive. He was less interested in closing an image than in sustaining a pictorial current.

The official Escritorio de Arte page traces a decisive turn in the mid-1940s. After early experiments and recognition in Fortaleza, Bandeira moved to Rio de Janeiro and soon reached Paris on a study grant in 1946. There he studied, exhibited, and absorbed the atmosphere of postwar European art. Paris did not erase his origins. Instead, it gave him a new arena in which to test how far his painting could go. By the early 1950s, his presence in exhibitions connected to nonfigurative art placed him in direct contact with the debates around informal abstraction.

What makes Bandeira compelling, though, is that his abstraction never feels cold. Even when forms dissolve into marks, stains, and floating structures, the work keeps an emotional temperature. The paintings do not read like exercises in pure geometry. They feel closer to pulse, atmosphere, or urban flicker. In many of his canvases, line works less like contour than like energy. Color does not simply fill space; it activates it.

Two works currently documented on Escritorio de Arte make that clear in different ways. In *Cidade* from 1959, oil on canvas becomes a field of suspended structure. The title suggests a city, but the image does not describe streets or buildings literally. Instead, Bandeira captures the sensation of a city as rhythm, compression, and luminous instability. The painting feels inhabited by movement even when it remains still. It is urbanity translated into marks and intervals.

The untitled oil on canvas from 1962 pushes that language further. Here the emphasis seems less on the city as a reference and more on the autonomy of the painted event itself. The work shows how Bandeira could move from allusion to atmosphere without losing coherence. What holds the picture together is not subject matter in the conventional sense, but a disciplined orchestration of gesture, tone, and spacing. That is one reason his abstraction continues to feel persuasive: it is never vague. However open the image becomes, the painting remains exact in its own terms.

Another striking aspect of Bandeira's trajectory is how naturally it links Northeastern Brazil to a broader international history of modern painting. Fortaleza, Rio, and Paris are not separate chapters in his work so much as connected pressures inside it. The energy of his line, the chromatic tension of his surfaces, and the refusal of easy closure all suggest an artist who understood painting as a site of permanent becoming. His canvases invite us to look not for a final answer, but for the momentum of form in the act of arriving.

That helps explain why Bandeira still matters to anyone trying to understand Brazilian modern art beyond the usual simplified narratives. He was not merely following abstraction. He was giving it another accent: one more nervous, lyrical, and open to instability. In his hands, abstraction became less a retreat from the world than a way of registering its force.

Antonio Bandeira's work remains powerful because it balances rigor and movement. The paintings are built, but they also breathe. They suggest architecture without becoming fixed, emotion without becoming sentimental, and gesture without becoming arbitrary. What stays with the viewer is the sense that painting, for Bandeira, was never a finished object. It was an ongoing field of intensity.

Keywords: Antonio Bandeira, Brazilian abstraction, Fortaleza, Paris, modern Brazilian art`,
};

const IMAGES: Image[] = [
  {
    url: 'https://www.escritoriodearte.com/quadro/antonio-bandeira-cidade-oleo-sobre-tela-18260g.webp',
    caption: 'Cidade (1959), oil on canvas, 46 x 55 cm.',
    attribution: 'Escritorio de Arte.',
  },
  {
    url: 'https://www.escritoriodearte.com/quadro/antonio-bandeira-sem-titulo-oleo-sobre-tela-9095g.webp',
    caption: 'Sem Titulo (1962), oil on canvas, 70 x 110 cm.',
    attribution: 'Escritorio de Arte.',
  },
];

async function ensureArtist() {
  const existing = await artistOps.findByNameAndCity('Antonio Bandeira', 'Fortaleza');
  if (existing?.id) {
    if (existing.status !== 'verified') {
      await artistOps.updateStatus(existing.id, 'verified');
    }
    return existing.id;
  }

  return artistOps.create({
    full_name: 'Antonio Bandeira',
    birthplace_city: 'Fortaleza',
    birthplace_state: 'Ceara',
    visual_practice: 'painting',
    status: 'verified',
    metadata: JSON.stringify({
      birth_year: '1922',
      death_year: '1967',
      note: 'Manual replacement artist with verified artwork pages.',
    }),
  });
}

async function ensureSources(artistId: number) {
  const sources = [
    {
      url: 'https://www.escritoriodearte.com/artista/antonio-bandeira',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Biographical page states that Antonio Bandeira was born in Fortaleza in 1922 and died in Paris in 1967. It describes his early role in the Centro Cultural de Belas Artes and Sociedade Cearense de Belas Artes, his move to Rio de Janeiro in 1945, his scholarship to Paris in 1946, his study at the Ecole Superieure des Beaux Arts and Academie de la Grande Chaumiere, and his involvement with nonfigurative painting and informal abstraction in the 1950s.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/antonio-bandeira/cidade-18260',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Artwork listing for Cidade documents a 1959 oil on canvas by Antonio Bandeira measuring 46 by 55 centimeters.',
    },
    {
      url: 'https://www.escritoriodearte.com/artista/antonio-bandeira/sem-titulo-9095',
      institution: 'Escritorio de Arte',
      credibility_score: 0.9,
      content_summary:
        'Artwork listing for Sem Titulo documents a 1962 oil on canvas by Antonio Bandeira measuring 70 by 110 centimeters.',
    },
  ];

  for (const source of sources) {
    const exists = await sourceOps.exists(artistId, source.url);
    if (!exists) {
      await sourceOps.create({ artist_id: artistId, ...source });
    }
  }
}

async function clearPendingReplacementRequests() {
  const logs = await publishingOps.findFailed();
  for (const log of logs) {
    if (log.id && log.error_message === 'replacement_requested') {
      await publishingOps.delete(log.id);
    }
  }
}

async function main() {
  initDatabase();

  try {
    const artistId = await ensureArtist();
    await ensureSources(artistId);

    const draftId = await draftOps.create({
      artist_id: artistId,
      title: ARTICLE.title,
      subtitle: ARTICLE.subtitle,
      content: ARTICLE.content,
      status: 'pending',
    });

    const email = new EmailModule(config.env.resendApiKey);
    await email.sendApprovalEmail({
      draftId,
      images: IMAGES,
    });

    await clearPendingReplacementRequests();

    console.log(`✅ Antonio Bandeira replacement email sent with draft ${draftId}`);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('❌ Failed to send Antonio Bandeira replacement email:', error);
  closeDatabase();
  process.exit(1);
});
