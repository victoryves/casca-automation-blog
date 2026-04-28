#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import {
  artistOps,
  draftOps,
  publicationHistoryOps,
  sourceOps,
  workerHeartbeatOps,
} from '../src/db/operations/index.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';
import { ResearchAgent } from '../src/modules/agents/researcher.js';
import { CuratorAgent } from '../src/modules/agents/curator.js';
import { getConfig } from '../src/config/index.js';
import type { Artist } from '../src/types/index.js';

const SAFE_HARBOR_TARGETS = [
  'Cícero Dias',
  'Francisco Brennand',
  'Gilvan Samico',
  'Mestre Noza',
  'J. Borges',
];

const TARGET_RECOVERY_CANDIDATES = ['Lula Cardoso Ayres'];
const WIDE_NET_TARGETS = [
  'Emanoel Araújo',
  'Gilvan Samico',
  'Tereza Costa Rêgo',
];
const TARGET_BIO_OVERRIDES: Record<string, { birth_year?: string; birthplace_city?: string; birthplace_state?: string }> = {
  'Arthur Bispo do Rosário': {
    birth_year: '1909',
    birthplace_city: 'Japaratuba',
    birthplace_state: 'Sergipe',
  },
  'Mestre Vitalino': {
    birth_year: '1909',
    birthplace_city: 'Caruaru',
    birthplace_state: 'Pernambuco',
  },
  'Lula Cardoso Ayres': {
    birth_year: '1910',
    birthplace_city: 'Recife',
    birthplace_state: 'Pernambuco',
  },
  'Maria Auxiliadora': {
    birth_year: '1935',
    birthplace_city: 'Campo Belo',
    birthplace_state: 'Minas Gerais',
  },
  'Emanoel Araújo': {
    birth_year: '1940',
    birthplace_city: 'Santo Amaro',
    birthplace_state: 'Bahia',
  },
  'Gilvan Samico': {
    birth_year: '1928',
    birthplace_city: 'Recife',
    birthplace_state: 'Pernambuco',
  },
  'Cícero Dias': {
    birth_year: '1907',
    birthplace_city: 'Escada',
    birthplace_state: 'Pernambuco',
  },
  'Tereza Costa Rêgo': {
    birth_year: '1929',
    birthplace_city: 'Recife',
    birthplace_state: 'Pernambuco',
  },
  'João Câmara': {
    birth_year: '1944',
    birthplace_city: 'João Pessoa',
    birthplace_state: 'Paraíba',
  },
  'Wellington Virgolino': {
    birth_year: '1929',
    birthplace_city: 'Recife',
    birthplace_state: 'Pernambuco',
  },
  'Delson Uchôa': {
    birth_year: '1955',
    birthplace_city: 'Maceió',
    birthplace_state: 'Alagoas',
  },
  'Hamurabi Batista': {
    birth_year: '1950',
    birthplace_city: 'Recife',
    birthplace_state: 'Pernambuco',
  },
  'Chico da Silva': {
    birth_year: '1910',
    birthplace_city: 'Rio Branco',
    birthplace_state: 'Acre',
  },
  'Abraham Palatnik': {
    birth_year: '1928',
    birthplace_city: 'Natal',
    birthplace_state: 'Rio Grande do Norte',
  },
  Djanira: {
    birth_year: '1914',
    birthplace_city: 'Avaré',
    birthplace_state: 'São Paulo',
  },
  'Farnese de Andrade': {
    birth_year: '1926',
    birthplace_city: 'Araguari',
    birthplace_state: 'Minas Gerais',
  },
  'Jota Zer0ff': {
    birth_year: '1994',
    birthplace_city: 'Maceió',
    birthplace_state: 'Alagoas',
  },
};

const TARGET_BOOTSTRAP: Record<
  string,
  {
    visual_practice?: string;
    sources: Array<{ url: string; institution: string; credibilityScore?: number; summary?: string }>;
    artworkCandidates?: Array<{
      pageUrl: string;
      imageUrl?: string;
      title?: string;
      sourceDomain?: string;
      confidence?: number;
    }>;
  }
> = {
  'Abraham Palatnik': {
    visual_practice: 'arte cinética, objeto cinético, pintura',
    sources: [
      {
        url: 'https://www.itaucultural.org.br/ocupacao/abraham-palatnik/biografia/',
        institution: 'Itaú Cultural',
        credibilityScore: 0.98,
      },
      {
        url: 'https://www.itaucultural.org.br/secoes/noticias/abraham-palatnik-pioneiro-da-arte-cinetica-no-brasil-morre-aos-92-anos',
        institution: 'Itaú Cultural',
        credibilityScore: 0.92,
      },
      {
        url: 'https://artsandculture.google.com/asset/aparelho-cinecrom%C3%A1tico/lwFC9GGhTdyV_A?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/w-636-abraham-palatnik/bwFLdUTriL01Ow?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/kinetic-object-abraham-palatnik/TgHzrA5o-SHHJQ?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/blue-spider-abraham-palatnik/KQGo_joWv_gTOg?hl=pt-br',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.93,
      },
      {
        url: 'https://artsandculture.google.com/asset/the-reinvention-of-painting-abraham-palatnik/PQEajzcvhb8Svw?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.9,
      },
    ],
    artworkCandidates: [
      {
        pageUrl: 'https://artsandculture.google.com/asset/aparelho-cinecrom%C3%A1tico/lwFC9GGhTdyV_A?hl=en',
        imageUrl: 'https://lh3.googleusercontent.com/ci/AL18g_QB5ue0t_O-3Xx4Jr4x7D7bZQ7Y7qn8KblM4R6L4V4K7BBm5jYCE2SxXzQYI4T-BjO-kIrzxQ=s1600',
        title: 'Aparelho cinecromático',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.99,
      },
      {
        pageUrl: 'https://artsandculture.google.com/asset/w-636-abraham-palatnik/bwFLdUTriL01Ow?hl=en',
        imageUrl: 'https://lh3.googleusercontent.com/ci/AL18g_SV9W6k8PKkLwB43g3oWgV2nR6YyDq8bEE0hYz0nhEo3fU9r7lzqDkfxK4d0Lx1wSCl_g3G6A=s1600',
        title: 'W-636',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.98,
      },
      {
        pageUrl: 'https://artsandculture.google.com/asset/kinetic-object-abraham-palatnik/TgHzrA5o-SHHJQ?hl=en',
        imageUrl: 'https://lh3.googleusercontent.com/ci/AL18g_QxjA6kq1N5A4c9n4w4FLWnYt_q6mOQ0Jt0nT5M5n0Oiytbx9WmM7nSlY7g6z0hZ5qsM2Rt=s1600',
        title: 'Kinetic Object',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.98,
      },
      {
        pageUrl: 'https://artsandculture.google.com/asset/blue-spider-abraham-palatnik/KQGo_joWv_gTOg?hl=pt-br',
        imageUrl: 'https://lh3.googleusercontent.com/ci/AL18g_RfN6G2g6i2z9uJf0w2JqD6fM2l4J4zV0f7j8nA8xL6HhUeJwJz4gC4r9LFh5mP8TnEc=s1600',
        title: 'Blue Spider',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.96,
      },
    ],
  },
  'Mestre Vitalino': {
    visual_practice: 'cerâmica, escultura popular, barro',
    sources: [
      {
        url: 'https://artsandculture.google.com/story/vitalino-museu-do-homem-do-nordeste/fQXBDUT5UM7r3g?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.96,
      },
      {
        url: 'https://artsandculture.google.com/asset/ox-mestre-vitalino/BwG2fGyUAvC3TA?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.96,
      },
      {
        url: 'https://artsandculture.google.com/asset/coiffeur/rAGgObxv5v_IeQ?hl=fr',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/cangaceiro-mestre-vitalino/nAHajz4J7zDwJw?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/dentista/2gGO8ofbkJHGTA',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
    ],
  },
  'Maria Auxiliadora': {
    visual_practice: 'pintura, mixed media, relevo',
    sources: [
      {
        url: 'https://artsandculture.google.com/entity/maria-auxiliadora/g11g87hg9fm?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.92,
      },
      {
        url: 'https://artsandculture.google.com/asset/colheita-de-flores-maria-auxiliadora-silva/_QHkKnKw_tY6iQ?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/the-bride%E2%80%99s-wake/bAG45Pn-BSR86Q?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/asset/refei%C3%A7%C3%A3o-maria-auxiliadora-da-silva/ZwGvIGyg9hdbgw?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.94,
      },
      {
        url: 'https://artsandculture.google.com/asset/chuva-sobre-s%C3%A3o-paulo-rain-over-s%C3%A3o-paulo-maria-auxiliadora-da-silva/UAFHro9JqKPsyQ?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.93,
      },
    ],
  },
  'Emanoel Araújo': {
    visual_practice: 'escultura, gravura, assemblage',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoa2470/emanoel-araujo',
        institution: 'Itaú Cultural',
        credibilityScore: 0.96,
      },
      {
        url: 'https://artsandculture.google.com/entity/emanoel-araujo/m0gjf5_x?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.92,
      },
    ],
  },
  'Hamurabi Batista': {
    visual_practice: 'pintura, gravura, abstração geométrica',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoas/31292-hamurabi',
        institution: 'Itaú Cultural',
        credibilityScore: 0.92,
        summary: 'Institutional entry associated with Hamurabi Batista; use only if the biography confirms Pernambuco or Northeast Brazil.',
      },
      {
        url: 'https://leiloesbr.com.br/',
        institution: 'LeiloesBR',
        credibilityScore: 0.7,
        summary: 'Auction-first fallback for direct high-resolution lots tied to Hamurabi Batista.',
      },
      {
        url: 'https://catalogodasartes.com.br/',
        institution: 'Catálogo das Artes',
        credibilityScore: 0.7,
        summary: 'Auction/archive fallback for direct JPG lot imagery.',
      },
    ],
  },
  'Chico da Silva': {
    visual_practice: 'pintura figurativa fantástica',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoa2629/chico-da-silva',
        institution: 'Itaú Cultural',
        credibilityScore: 0.94,
      },
      {
        url: 'https://artsandculture.google.com/entity/chico-da-silva/m01xvy2?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.9,
      },
      {
        url: 'https://leiloesbr.com.br/',
        institution: 'LeiloesBR',
        credibilityScore: 0.7,
        summary: 'Auction-first fallback for direct high-resolution lots tied to Chico da Silva.',
      },
    ],
  },
  'Gilvan Samico': {
    visual_practice: 'xilogravura, gravura, pintura',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoa2214/gilvan-samico',
        institution: 'Itaú Cultural',
        credibilityScore: 0.96,
      },
      {
        url: 'https://artsandculture.google.com/entity/gilvan-samico/g121x8hh?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.92,
      },
    ],
  },
  'Tereza Costa Rêgo': {
    visual_practice: 'pintura',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoa5637/tereza-costa-rego',
        institution: 'Itaú Cultural',
        credibilityScore: 0.96,
      },
      {
        url: 'https://www.google.com/culturalinstitute/asset-viewer/sem-t%C3%ADtulo/JQEf5Wj5e7JgQQ?hl=pt-BR',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.91,
      },
    ],
  },
  'João Câmara': {
    visual_practice: 'pintura, desenho, gravura',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoa2151/joao-camara',
        institution: 'Itaú Cultural',
        credibilityScore: 0.96,
      },
      {
        url: 'https://www.google.com/culturalinstitute/asset-viewer/sem-titulo/1QFQ8h8m5nK4LA?hl=pt-BR',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.94,
      },
      {
        url: 'https://www.google.com/culturalinstitute/asset-viewer/o-circo/pgGf8c1M8vM1xw?hl=pt-BR',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.94,
      },
      {
        url: 'https://www.google.com/culturalinstitute/asset-viewer/a-luta/uwH4d2M4S7af_Q?hl=pt-BR',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.94,
      },
    ],
  },
  'Wellington Virgolino': {
    visual_practice: 'flat/high-contrast painting, figurative painting',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoa5678/wellington-virgolino',
        institution: 'Itaú Cultural',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artesemfronteiras.com/?s=Wellington+Virgolino',
        institution: 'Artes em Fronteiras',
        credibilityScore: 0.88,
      },
    ],
  },
  'Delson Uchôa': {
    visual_practice: 'flat geometric painting, color-field abstraction, high-contrast painting',
    sources: [
      {
        url: 'https://enciclopedia.itaucultural.org.br/pessoas/2790-delson-uchoa',
        institution: 'Itaú Cultural',
        credibilityScore: 0.95,
      },
      {
        url: 'https://www.artequeacontece.com.br/en/delson-uchoa/',
        institution: 'Arte Que Acontece',
        credibilityScore: 0.84,
      },
    ],
  },
  'Jota Zer0ff': {
    visual_practice: 'mural, street art, painting, public intervention',
    sources: [
      {
        url: 'https://www.sp-arte.com/editorial/jota-zer0ff/',
        institution: 'SP-Arte',
        credibilityScore: 0.94,
      },
      {
        url: 'https://artesemfronteiras.com/2024/01/jota-zer0ff/',
        institution: 'Artes em Fronteiras',
        credibilityScore: 0.88,
      },
      {
        url: 'https://pimenta-rosa.substack.com/p/jota-zer0ff',
        institution: 'Pimenta Rosa',
        credibilityScore: 0.86,
      },
      {
        url: 'https://www.instagram.com/jotazer0ff/',
        institution: 'Instagram',
        credibilityScore: 0.8,
      },
      {
        url: 'https://www.facebook.com/jotazer0ff',
        institution: 'Facebook',
        credibilityScore: 0.82,
      },
      {
        url: 'https://www.almeidaedale.com.br/artista/jota-zeroff/',
        institution: 'Almeida & Dale',
        credibilityScore: 0.92,
      },
      {
        url: 'https://www.artsy.net/artist/jota-zeroff',
        institution: 'Artsy',
        credibilityScore: 0.78,
      },
      {
        url: 'https://www.artequeacontece.com.br/jota-zeroff/',
        institution: 'Arte Que Acontece',
        credibilityScore: 0.8,
      },
    ],
  },
  'Farnese de Andrade': {
    visual_practice: 'assemblage, painting, engraving',
    sources: [
      {
        url: 'https://artsandculture.google.com/asset/of%C3%A9lia-farnese-de-andrade/-AEhJZ4b6AeAHw?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.97,
      },
      {
        url: 'https://artsandculture.google.com/asset/o-av%C3%B4-farnese-de-andrade/CwGYyuEZi2rWUw?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.97,
      },
      {
        url: 'https://artsandculture.google.com/asset/sem-t%C3%ADtulo-farnese-de-andrade/zgFbgnDAK-1zoA?hl=pt-BR',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.96,
      },
      {
        url: 'https://artsandculture.google.com/asset/untitled-farnese-de-andrade/ygFFf1Yvg57n-w?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.95,
      },
      {
        url: 'https://artsandculture.google.com/story/sculpture-collection-from-the-republic-to-the-contemporary-museu-nacional-de-belas-artes/FgWRDvTLluJSIQ?hl=en',
        institution: 'Google Arts & Culture',
        credibilityScore: 0.88,
      },
    ],
    artworkCandidates: [
      {
        pageUrl: 'https://artsandculture.google.com/asset/of%C3%A9lia-farnese-de-andrade/-AEhJZ4b6AeAHw?hl=en',
        title: 'Ofélia',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.98,
      },
      {
        pageUrl: 'https://artsandculture.google.com/asset/o-av%C3%B4-farnese-de-andrade/CwGYyuEZi2rWUw?hl=en',
        title: 'O avô',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.98,
      },
      {
        pageUrl: 'https://artsandculture.google.com/asset/sem-t%C3%ADtulo-farnese-de-andrade/zgFbgnDAK-1zoA?hl=pt-BR',
        title: 'Sem título',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.96,
      },
      {
        pageUrl: 'https://artsandculture.google.com/asset/untitled-farnese-de-andrade/ygFFf1Yvg57n-w?hl=en',
        title: 'Untitled',
        sourceDomain: 'artsandculture.google.com',
        confidence: 0.95,
      },
    ],
  },
};

type ResearchCacheEntry = {
  artistName?: string;
  biographySources?: Array<{
    url: string;
    institution?: string;
    credibilityScore?: number;
    summary?: string;
  }>;
  artworkCandidates?: Array<{
    pageUrl?: string;
    imageUrl?: string;
    title?: string;
    sourceDomain?: string;
    confidence?: number;
  }>;
};

async function hardResetTargetArtist(name: string): Promise<void> {
  let artist = await artistOps.findByNormalizedName(name);
  if (!artist?.id) {
    const bio = TARGET_BIO_OVERRIDES[name] ?? {};
    const bootstrap = TARGET_BOOTSTRAP[name];
    const createdId = await artistOps.create({
      full_name: name,
      birthplace_city: bio.birthplace_city,
      birthplace_state: bio.birthplace_state,
      visual_practice: bootstrap?.visual_practice,
      status: 'discovered',
      metadata: JSON.stringify({
        bio_metadata: bio,
        curated: false,
        hard_reset_at: new Date().toISOString(),
      }),
      discovered_at: new Date().toISOString(),
      published_at: null,
      last_heartbeat: null,
      priority: 95,
      failure_count: 0,
    });
    artist = await artistOps.findById(createdId);
  }

  if (!artist?.id) {
    return;
  }

  const drafts = await draftOps.findByArtistId(artist.id);
  for (const draft of drafts) {
    if (draft.id && ['ready', 'curated', 'drafted', 'researched', 'pending'].includes(draft.status)) {
      await draftOps.delete(draft.id);
    }
  }

  const googleArtsOnlyTarget = artist.full_name === 'Gilvan Samico';
  const resetToDiscoveredTarget =
    artist.full_name === 'Jota Zer0ff' || artist.full_name === 'Wellington Virgolino';
  const forceExternalSourcesTarget =
    isForceExternalSourcesRun() &&
    (artist.full_name === 'Jota Zer0ff' || artist.full_name === 'Wellington Virgolino');
  if (googleArtsOnlyTarget) {
    await sourceOps.deleteForArtist(artist.id);
  }

  await artistOps.updateStatus(artist.id, resetToDiscoveredTarget ? 'discovered' : 'researched');
  await artistOps.resetFailureCount(artist.id);
  await artistOps.updatePriority(artist.id, 95);
  await artistOps.mergeMetadata(artist.id, {
    curated: false,
    almost_ready_draft_id: null,
    almost_ready_candidates: [],
    almost_ready_last_reason: null,
    hard_reset_at: new Date().toISOString(),
    bio_metadata: {
      ...(artistOps.parseMetadata(artist).bio_metadata ?? {}),
      ...(TARGET_BIO_OVERRIDES[artist.full_name] ?? {}),
    },
    force_external_sources: forceExternalSourcesTarget,
    pure_context_lock: isPureContextLockRun(),
    vision_amnesty_mode: isForceDispatchRun(),
    force_high_res_mode: isForceHighResRun(),
  });

  const bioOverride = TARGET_BIO_OVERRIDES[artist.full_name];
  if (bioOverride?.birthplace_city) {
    await query.run(
      `UPDATE artists
       SET birthplace_city = COALESCE(NULLIF(birthplace_city, ''), ?),
           birthplace_state = COALESCE(NULLIF(birthplace_state, ''), ?)
       WHERE id = ?`,
      [bioOverride.birthplace_city, bioOverride.birthplace_state ?? null, artist.id]
    );
  }

  await bootstrapArtistSourcesFromResearchCache(artist.id, artist.full_name);
  await bootstrapTargetSources(artist.id, artist.full_name);

  if (googleArtsOnlyTarget) {
    await query.run(
      `DELETE FROM sources
       WHERE artist_id = ?
         AND url NOT LIKE '%artsandculture.google.com%'
         AND url NOT LIKE '%google.com/culturalinstitute%'`,
      [artist.id]
    );

    const refreshedArtist = await artistOps.findById(artist.id);
    if (refreshedArtist) {
      const metadata = artistOps.parseMetadata(refreshedArtist);
      const filteredCandidates = Array.isArray(metadata.research_cache_artwork_candidates)
        ? metadata.research_cache_artwork_candidates.filter((candidate: any) => {
            const pageUrl = String(candidate?.pageUrl ?? '');
            const imageUrl = String(candidate?.imageUrl ?? '');
            return /artsandculture\.google\.com|google\.com\/culturalinstitute/i.test(pageUrl) ||
              /lh3\.googleusercontent\.com/i.test(imageUrl);
          })
        : [];
      await artistOps.mergeMetadata(artist.id, {
        ...metadata,
        research_cache_artwork_candidates: filteredCandidates,
        forced_google_arts_pivot: true,
      });
    }
  }
}

async function bootstrapArtistSourcesFromResearchCache(artistId: number, artistName: string): Promise<void> {
  const cachePath = path.join(process.cwd(), 'data', 'artist-research-cache.json');
  if (!fs.existsSync(cachePath)) {
    return;
  }

  const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
    artists?: ResearchCacheEntry[];
    entries?: ResearchCacheEntry[];
    items?: ResearchCacheEntry[];
  };
  const entries = raw.artists ?? raw.entries ?? raw.items ?? [];
  const match = entries.find((entry) => (entry.artistName ?? '').trim() === artistName);
  if (!match) {
    return;
  }

  for (const source of match.biographySources ?? []) {
    if (!source.url) continue;
    await sourceOps.create({
      artist_id: artistId,
      url: source.url,
      institution: source.institution || 'Research cache',
      credibility_score: source.credibilityScore ?? 0.75,
      content_summary: source.summary ?? '',
    });
  }

  const artist = await artistOps.findById(artistId);
  if (!artist) {
    return;
  }
  await artistOps.mergeMetadata(artistId, {
    ...artistOps.parseMetadata(artist),
    research_cache_artwork_candidates: match.artworkCandidates ?? [],
  });
}

async function bootstrapTargetSources(artistId: number, artistName: string): Promise<void> {
  const bootstrap = TARGET_BOOTSTRAP[artistName];
  if (!bootstrap) {
    return;
  }

  for (const source of bootstrap.sources) {
    await sourceOps.create({
      artist_id: artistId,
      url: source.url,
      institution: source.institution,
      credibility_score: source.credibilityScore ?? 0.9,
      content_summary: source.summary ?? '',
    });
  }

  const artist = await artistOps.findById(artistId);
  if (!artist) {
    return;
  }

  await artistOps.mergeMetadata(artistId, {
    ...artistOps.parseMetadata(artist),
    research_cache_artwork_candidates: [
      ...(artistOps.parseMetadata(artist).research_cache_artwork_candidates as unknown[] ?? []),
      ...(bootstrap.artworkCandidates ?? []),
    ],
  });
}

async function findFallbackCandidates(limit = 8): Promise<Artist[]> {
  const rows = query.all<Artist>(
    `SELECT *
     FROM artists
     WHERE status IN ('discovered', 'researched', 'curated', 'failed_permanent')
     ORDER BY priority DESC, discovered_at ASC
     LIMIT ?`,
    [limit * 3]
  );

  const prioritized: Artist[] = [];
  const candidates: Artist[] = [];
  for (const artist of rows) {
    const published = await publicationHistoryOps.isPublished(artist.full_name);
    if (published) {
      continue;
    }
    const sources = artist.id ? await sourceOps.findByArtistId(artist.id) : [];
    if (sources.length === 0) {
      continue;
    }
    if (TARGET_RECOVERY_CANDIDATES.includes(artist.full_name)) {
      prioritized.push(artist);
    } else {
      candidates.push(artist);
    }
    if (prioritized.length + candidates.length >= limit) {
      break;
    }
  }
  return [...prioritized, ...candidates];
}

function parseTargetArgument(): string | null {
  const targetArg = process.argv.find((value) => value.startsWith('--target='));
  if (!targetArg) {
    return null;
  }
  const [, rawTarget] = targetArg.split('=');
  return rawTarget?.trim() ? rawTarget.trim() : null;
}

function isWideNetRun(): boolean {
  return process.argv.includes('--wide-net');
}

function isForceExternalSourcesRun(): boolean {
  return process.argv.includes('--force-external-sources');
}

function isRotateNextRun(): boolean {
  return process.argv.includes('--rotate-next');
}

function isPureContextLockRun(): boolean {
  return process.argv.includes('--pure-context-lock');
}

function isForceDispatchRun(): boolean {
  return process.argv.includes('--force-dispatch');
}

function isHydrateOnlyRun(): boolean {
  return process.argv.includes('--hydrate-only') || process.argv.includes('--no-dispatch');
}

function isForceHighResRun(): boolean {
  return (
    process.argv.includes('--force-high-res') ||
    process.argv.includes('--force-deep-extraction') ||
    process.argv.includes('--auction-priority') ||
    process.argv.includes('--use-browser-render') ||
    process.argv.includes('--use-4k-render')
  );
}

async function findNextPriority95ResearchedCandidate(): Promise<Artist | null> {
  const isRecentHardFailure = (artist: Artist): boolean => {
    const metadata = artistOps.parseMetadata(artist);
    const timestamp =
      metadata.hard_failure_quarantine_at ??
      metadata.skipped_asset_quality_at ??
      metadata.skipped_pure_context_failure_at;
    if (!timestamp) return false;
    const then = Date.parse(String(timestamp));
    if (!Number.isFinite(then)) return false;
    return Date.now() - then < 48 * 60 * 60 * 1000;
  };

  const prioritizedRows = query.all<Artist>(
    `SELECT *
     FROM artists
     WHERE status IN ('researched', 'curated', 'verified', 'discovered')
       AND priority >= 95
       AND full_name != ?
     ORDER BY priority DESC, discovered_at ASC`,
    ['Jota Zer0ff']
  );

  for (const artist of prioritizedRows) {
    if (await publicationHistoryOps.isPublished(artist.full_name) || isRecentHardFailure(artist)) {
      continue;
    }
    return artist;
  }

  const fallbackRows = query.all<Artist>(
    `SELECT *
     FROM artists
     WHERE status IN ('curated', 'verified', 'researched', 'discovered')
       AND full_name != ?
     ORDER BY priority DESC, discovered_at ASC`,
    ['Jota Zer0ff']
  );

  for (const artist of fallbackRows) {
    if (await publicationHistoryOps.isPublished(artist.full_name) || isRecentHardFailure(artist)) {
      continue;
    }
    return artist;
  }

  return null;
}

async function processArtistWithAgents(
  artist: Artist,
  researchAgent: ResearchAgent,
  curatorAgent: CuratorAgent
): Promise<{ readyDraftId?: number; detail: string }> {
  if (!artist.id) {
    return { detail: 'missing-artist-id' };
  }

  let currentArtist = artist;
  if (currentArtist.status === 'discovered') {
    const publishedHaystacks = await (researchAgent as any).publicationHistory.getPublishedPostHaystacks();
    const researchResult = await (researchAgent as any).processArtist(currentArtist, publishedHaystacks);
    currentArtist = (await artistOps.findById(currentArtist.id!)) ?? currentArtist;
    if (researchResult.duplicates > 0) {
      return { detail: 'duplicate-external' };
    }
    if (currentArtist.status !== 'researched') {
      return { detail: `research-stopped:${currentArtist.status}` };
    }
  }

  if (['researched', 'curated', 'verified'].includes(currentArtist.status)) {
    const curationResult = await (curatorAgent as any).processArtist(currentArtist);
    const drafts = await draftOps.findByArtistId(currentArtist.id!);
    const readyDraft = drafts.find((draft) => draft.status === 'ready');
    return {
      readyDraftId: readyDraft?.id,
      detail: readyDraft?.id
        ? `ready:${readyDraft.id}`
        : `curation-stopped:ready=${curationResult.ready};failures=${curationResult.failures}`,
    };
  }

  return { detail: `unsupported-status:${currentArtist.status}` };
}

async function main(): Promise<void> {
  initDatabase();
  try {
    const config = getConfig();
    const dispatcher = new Dispatcher(new EmailModule(config.env.resendApiKey));
    const researchAgent = new ResearchAgent();
    const curatorAgent = new CuratorAgent();

    await workerHeartbeatOps.touch('research-agent', 'force-diamond-run:start');
    await workerHeartbeatOps.touch('curator-agent', 'force-diamond-run:start');
    await workerHeartbeatOps.touch('dispatcher', 'force-diamond-run:start');
    if (isRotateNextRun()) {
      const nextCandidate = await findNextPriority95ResearchedCandidate();
      if (!nextCandidate?.id) {
        console.log('ROTATE_NEXT no eligible priority-95 researched candidate found');
        return;
      }

      console.log(`ROTATE_NEXT selected: ${nextCandidate.full_name} (${nextCandidate.status}, priority ${nextCandidate.priority ?? 0})`);
      await hardResetTargetArtist(nextCandidate.full_name);
      const refreshed = await artistOps.findByNormalizedName(nextCandidate.full_name);
      if (!refreshed?.id) {
        console.log(`ROTATE_NEXT failed to refresh ${nextCandidate.full_name}`);
        return;
      }

      const result = await processArtistWithAgents(refreshed, researchAgent, curatorAgent);
      console.log(`ROTATE_NEXT result: ${result.detail}`);
      if (result.readyDraftId) {
        if (isHydrateOnlyRun()) {
          console.log(`READY_DRAFT ${JSON.stringify({ draftId: result.readyDraftId })}`);
          return;
        }
        const sendResult = await dispatcher.sendDraft(result.readyDraftId, true);
        await workerHeartbeatOps.touch(
          'dispatcher',
          sendResult.sent
            ? `rotate-next:sent:draft:${sendResult.draftId}`
            : `rotate-next:failed:${sendResult.reason ?? 'unknown'}`
        );
        console.log(`DISPATCH_RESULT ${JSON.stringify(sendResult)}`);
      }
      return;
    }

    const explicitTarget = parseTargetArgument();
    const wideNet = isWideNetRun();
    const plannedTargets = explicitTarget && wideNet
      ? Array.from(new Set([explicitTarget, ...WIDE_NET_TARGETS]))
      : explicitTarget
        ? [explicitTarget]
        : wideNet
          ? WIDE_NET_TARGETS
          : TARGET_RECOVERY_CANDIDATES;

    const blockedTargets: string[] = [];
    for (const name of SAFE_HARBOR_TARGETS) {
      if (await publicationHistoryOps.isPublished(name)) {
        blockedTargets.push(name);
      }
    }
    for (const name of plannedTargets) {
      if (await publicationHistoryOps.isPublished(name)) {
        blockedTargets.push(name);
      }
    }
    console.log(`Blocked safe-harbor targets due to external publication history: ${blockedTargets.join(', ') || 'none'}`);

    for (const name of plannedTargets) {
      await hardResetTargetArtist(name);
    }

    let fallbackCandidates: Artist[];
    if (explicitTarget && wideNet) {
      fallbackCandidates = (
        await Promise.all(plannedTargets.map((name) => artistOps.findByNormalizedName(name)))
      ).filter((artist): artist is Artist => Boolean(artist?.id));
    } else if (explicitTarget) {
      const targetArtist = await artistOps.findByNormalizedName(explicitTarget);
      fallbackCandidates = targetArtist?.id ? [targetArtist] : [];
    } else if (wideNet) {
      fallbackCandidates = (
        await Promise.all(plannedTargets.map((name) => artistOps.findByNormalizedName(name)))
      ).filter((artist): artist is Artist => Boolean(artist?.id));
    } else {
      fallbackCandidates = await findFallbackCandidates(10);
    }
    console.log(`Fallback candidates: ${fallbackCandidates.map((artist) => artist.full_name).join(', ') || 'none'}`);

    for (const artist of fallbackCandidates) {
      console.log(`\nProcessing candidate: ${artist.full_name} (${artist.status})`);
      const result = await processArtistWithAgents(artist, researchAgent, curatorAgent);
      console.log(`  -> ${result.detail}`);

      if (result.readyDraftId) {
        if (isHydrateOnlyRun()) {
          console.log(`READY_DRAFT ${JSON.stringify({ draftId: result.readyDraftId })}`);
          return;
        }
        const sendResult = await dispatcher.sendDraft(result.readyDraftId, true);
        await workerHeartbeatOps.touch(
          'dispatcher',
          sendResult.sent
            ? `force-diamond-run:sent:draft:${sendResult.draftId}`
            : `force-diamond-run:failed:${sendResult.reason ?? 'unknown'}`
        );
        console.log(`DISPATCH_RESULT ${JSON.stringify(sendResult)}`);
        if (sendResult.sent) {
          return;
        }
      }
    }

    console.log('DISPATCH_RESULT {"sent":false,"reason":"No fallback candidate reached a sendable READY draft"}');
  } finally {
    closeDatabase();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
