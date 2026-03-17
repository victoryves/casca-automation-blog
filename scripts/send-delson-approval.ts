#!/usr/bin/env tsx

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/supabase.js';
import { artistOps, draftOps, sourceOps } from '../src/db/operations/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import type { Image } from '../src/types/index.js';

const config = loadConfig();

const ARTICLE = {
  title: 'Delson Uchoa and the Latitude of Color',
  subtitle: 'From Maceio to Generation 80, a painter who turned Northeastern luminosity into a language of scale, material, and movement.',
  content: `Delson Uchoa belongs to that group of Brazilian artists whose work feels inseparable from place, yet never limited by it. Born in Maceio in 1956, he studied painting at Fundacao Pierre Chalita while completing his medical degree in 1981. That double formation matters. Even when his paintings are exuberant, they rarely feel loose in a casual sense. They are built with an almost structural intelligence, attentive to surface, density, layering, and the behavior of materials under light.

According to his official biography, Uchoa lived in Maceio until graduating in medicine, then traveled to France to study painting more deeply before returning to Brazil, with a brief stay in Belo Horizonte. He later settled in Rio de Janeiro and entered the landmark exhibition "Como vai voce? Geracao 80" at Parque Lage, organized by Marcus de Lontra Costa and Paulo Roberto Leal. That moment placed him inside one of the defining scenes of Brazilian painting in the 1980s, but his trajectory was never simply an echo of that generation. Even early on, critics around him were already responding to the friction in his work between the popular and the refined, the regional and the universal.

The biography on his site traces how that recognition developed. In the 1980s he joined Galeria Saramenha and held important solo exhibitions there in 1985 and 1988. His work then drew the attention of Thomas Cohn, who presented Uchoa within a broader national conversation that opened new space for artists from the North and Northeast. That framing is useful because Uchoa's art has always carried a distinctly Brazilian chromatic force without becoming picturesque. His paintings do not illustrate Northeastern culture in a literal way. Instead, they seem to extract rhythm, glare, heat, and sensory saturation from lived experience and transform them into pictorial events.

The paintings page of his official site makes that clear. A sequence of works from different periods shows how consistently he has pursued color as a material fact rather than a decorative effect. In pieces such as *Muxarabie* (1991-2006), *Alvorada* (1994-2010), *Pericardio* (2010), *Buganville* (2014), and *Particula U* (2015), acrylic and resin recur across canvas surfaces that often feel porous, radiant, and unstable in the best sense. Other works widen that vocabulary: *Quaradouro* combines acrylic, resin, cotton mesh, and wooden clothespins; *Tudo que reluz e ouro* includes metal tacks and plastic; *Bambole Delaunay* extends the field further with Chinese umbrellas; and *Fiacao* from 2019 moves into electrical wires on aluminum, later noted on the site as a donation to MASP.

That list of materials matters because it tells us Uchoa's art is not only about image. It is also about contact between substances. Canvas, resin, plastic, straw, metal, and industrial elements all enter the work as active participants. This makes his painting feel less like a window and more like an environment under construction. Even when the image remains frontal, the material decisions create a sense of circulation, as if color were passing through membranes, accumulating in layers, then dispersing again.

His career also shows a productive movement between Maceio and the major circuits of Brazilian contemporary art. After intense years in Rio, he returned for periods to Maceio, and in 1993 a workshop in the city led to a study grant and an exhibition at Galerie Springer in Berlin. In 1996 he mounted what his biography describes as his largest solo exhibition, spread across two sugar warehouses in Jaragua and covering roughly fifteen years of painting, from Generation 80 to the works then described as "mesticos de ultima geracao." The scale of that exhibition, promoted through billboards across the city, suggests an artist already thinking beyond the neutral white cube.

In 1998 he participated in the 24th Sao Paulo Biennial under Paulo Herkenhoff, who positioned Uchoa within a discussion of color, latitude, and the anthropophagic imagination in Brazilian art. The site preserves Herkenhoff's argument that Southeastern "caipira" color could not account for Brazil as a whole, and that Uchoa drew luminosity and cultural stridency from the color of the Northeast. It remains one of the sharpest descriptions of what his painting does. Uchoa's work does not treat color as an abstract system detached from life. It insists on color as weather, geography, memory, and cultural density.

The biography also records later milestones that reinforce the consistency of his trajectory: a 2001 TV Senac documentary focused on major works such as *Catedral* and *Curral da Praia*; a 2003 invitation from Aguinaldo Farias to exhibit at Tomie Ohtake alongside Caetano de Almeida and Cassio Michalany; and, in 2005, a major presentation at MAMAM in Recife curated by Moacir dos Anjos, alongside the acquisition of two works by the Museu de Belas Artes in Rio de Janeiro. His CV on the same page continues that arc into recent years, with exhibitions at Luciana Brito Galeria, Museu do Estado de Pernambuco, and Museu Oscar Niemeyer.

What emerges from these official materials is not just a successful exhibition history, but a strong internal logic. Uchoa has spent decades building a body of work in which painting absorbs architecture, objecthood, and popular visual energy without losing rigor. The result is a practice that expands what painting can hold: not only pigment, but climate; not only composition, but velocity; not only form, but the unstable life of matter itself.

Keywords: Delson Uchoa, Brazilian art, Northeast Brazil`,
};

const IMAGES: Image[] = [
  {
    url: 'https://static.wixstatic.com/media/338b4b_a126b1feaad24879bb6b2b3e52f38f97.jpg',
    caption: 'Muxarabie (1991-2006), acrylic and resin on canvas.',
    attribution: 'Official website, pinturas page.',
  },
  {
    url: 'https://static.wixstatic.com/media/338b4b_cb60d5f403b242eab5fde29bb2e959f9~mv2.jpg',
    caption: 'Pericardio (2010), acrylic and resin on canvas.',
    attribution: 'Official website, pinturas page.',
  },
  {
    url: 'https://static.wixstatic.com/media/338b4b_55b29daccd914e4bb67e8a21e2fd03c6~mv2.jpg',
    caption: 'Alvorada (1994-2010), acrylic, resin, and straw from the Sao Francisco River on canvas.',
    attribution: 'Official website, pinturas page.',
  },
  {
    url: 'https://static.wixstatic.com/media/338b4b_188800405d264aef92d06cd8ea4553c2~mv2.jpg',
    caption: 'Bambole Delaunay (2019), acrylic and resin on canvas with Chinese umbrellas.',
    attribution: 'Official website, pinturas page.',
  },
];

async function ensureArtist() {
  const existing = await artistOps.findByNameAndCity('Delson Uchoa', 'Maceió');
  if (existing?.id) {
    if (existing.status !== 'verified') {
      await artistOps.updateStatus(existing.id, 'verified');
    }
    return existing.id;
  }

  return artistOps.create({
    full_name: 'Delson Uchoa',
    birthplace_city: 'Maceió',
    birthplace_state: 'Alagoas',
    visual_practice: 'painting',
    status: 'verified',
    metadata: JSON.stringify({
      birth_year: '1956',
      based_in: 'Maceió, Brazil',
      note: 'Manually added from official website for approval email.',
    }),
  });
}

async function ensureSources(artistId: number) {
  const sources = [
    {
      url: 'https://www.delsonuchoa.com/biografia',
      institution: 'Delson Uchoa Official Website',
      credibility_score: 0.95,
      content_summary:
        'Official biography states the artist was born in Maceio in 1956, studied painting at Fundacao Pierre Chalita while graduating in medicine in 1981, later settled in Rio de Janeiro, participated in Geracao 80, showed with Galeria Saramenha and Thomas Cohn, mounted a major 1996 solo exhibition in Jaragua, joined the 24th Sao Paulo Biennial in 1998, and exhibited at institutions including Tomie Ohtake, MAMAM Recife, and Museu de Belas Artes do Rio de Janeiro.',
    },
    {
      url: 'https://www.delsonuchoa.com/pinturas',
      institution: 'Delson Uchoa Official Website',
      credibility_score: 0.95,
      content_summary:
        'Official paintings page lists works and materials including Tabuleiro, Muxarabie, Buganville, Buque, Particula U, Estufa F.8.8, Pericardio, Florescencia Acacia, Craibeira, Fiacao, Alvorada, Quaradouro, Tudo que reluz e ouro, Bambole Delaunay, and Ipe Roxo, with repeated use of acrylic, resin, canvas, plastic, straw, metal, and found materials.',
    },
  ];

  for (const source of sources) {
    const exists = await sourceOps.exists(artistId, source.url);
    if (!exists) {
      await sourceOps.create({ artist_id: artistId, ...source });
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

    console.log(`✅ Delson Uchoa approval email sent with draft ${draftId}`);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('❌ Failed to send Delson Uchoa approval email:', error);
  closeDatabase();
  process.exit(1);
});
