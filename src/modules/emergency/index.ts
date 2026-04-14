import { artistOps, draftOps, sourceOps } from '../../db/operations/index.js';
import type { Image } from '../../types/index.js';

export interface EmergencyFallbackDraft {
  sourceDraftId: number;
  draftId: number;
  artistId: number;
  artistName: string;
  images: Image[];
}

interface EmergencyCandidate {
  artist: {
    full_name: string;
    birthplace_city: string;
    birthplace_state: string;
    visual_practice: string;
    metadata?: Record<string, unknown>;
  };
  article: {
    title: string;
    subtitle: string;
    content: string;
  };
  images: Image[];
  sources: Array<{
    url: string;
    institution: string;
    credibility_score: number;
    content_summary: string;
  }>;
}

function articleBody(...paragraphs: string[]): string {
  return paragraphs.join('\n\n');
}

const EMERGENCY_CANDIDATES: EmergencyCandidate[] = [
  {
    artist: {
      full_name: 'Emanoel Araujo',
      birthplace_city: 'Santo Amaro da Purificacao',
      birthplace_state: 'Bahia',
      visual_practice: 'sculpture, printmaking, drawing',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Emanoel Araujo and the Sculptural Intelligence of Bahia',
      subtitle:
        'From Santo Amaro da Purificacao to the center of Brazilian cultural life, Araujo built an art of structure, rhythm, and Afro-Brazilian memory.',
      content: articleBody(
        `Emanoel Araujo occupies a singular place in Brazilian art because his practice was never confined to one material, one scale, or one institutional role. Born in Santo Amaro da Purificacao, Bahia, in 1940, he became known not only as a sculptor, engraver, draftsman, and printmaker, but also as one of the most influential curatorial and cultural voices in the country. That breadth matters because his visual work carries the same clarity of thought that later marked his public life: an intense concern with form, structure, history, and the visibility of Black Brazilian contribution to art and culture. Even when reduced to severe geometric relations, his works rarely feel cold. They hold rhythm, weight, and symbolic density.`,
        `The available biographical material places Araujo inside a long arc of artistic discipline and institutional leadership. Emerging from Bahia and later projecting himself nationally, he developed an oeuvre that moved across sculpture, relief, engraving, and graphic composition while sustaining a rigorous sense of construction. What is especially striking in his case is the way formal economy becomes expressive force. Vertical cuts, interlocking planes, repeated modules, and sharply balanced silhouettes give his work an architectural presence, but not a static one. The pieces seem to negotiate movement and stability at the same time, as if geometry were being used to think through ancestry, labor, and monumentality.`,
        `The works currently documented on Escritorio de Arte help make that language visible. The iron sculptures listed there show how decisively Araujo handled mass, void, and frontal presence. Even untitled works can feel unmistakably his because the logic of construction is so strong. The 1987 serigraph reveals another side of the same intelligence: the translation of sculptural rhythm into graphic terms. Meanwhile, the 1966 woodcut underscores how deeply printmaking informed his visual thinking. Across these mediums, there is a consistent vocabulary of compression, interval, and emphatic contour. He does not overload the image. He sharpens it until it can hold history through structure.`,
        `That is a large part of Emanoel Araujo's importance. He demonstrated that formal rigor and cultural depth do not compete with one another. In his hands, abstraction could remain materially grounded, and the language of modern construction could become a vehicle for Afro-Brazilian affirmation rather than an escape from context. His art continues to matter because it is both exact and expansive: exact in line, plane, and proportion; expansive in the historical worlds it activates. Looking at Araujo, one sees not only an artist of great discipline, but one who understood form as a way of giving memory durable public presence.`
      ),
    },
    images: [
      {
        url: 'https://www.escritoriodearte.com/quadro/emanoel-araujo-sem-titulo-escultura-em-ferro-26396g.webp',
        caption: 'Sem Titulo, iron sculpture',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/emanoel-araujo-sem-titulo-serigrafia-26394g.webp',
        caption: 'Sem Titulo, serigraph, 1987',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/emanoel-araujo-sem-titulo-xilogravura-25632g.webp',
        caption: 'Sem Titulo, woodcut, 1966',
        attribution: 'Escritorio de Arte',
      },
    ],
    sources: [
      {
        url: 'https://www.escritoriodearte.com/artista/emanoel-araujo',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Biographical page for Emanoel Araujo with overview of his trajectory as a Bahian artist, sculptor, engraver, draftsman, curator, and major Afro-Brazilian cultural figure, alongside multiple artwork records currently available on the site.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/emanoel-araujo/sem-titulo-26396',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for an untitled iron sculpture by Emanoel Araujo measuring 15 x 45 x 31 cm.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/emanoel-araujo/sem-titulo-26394',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for an untitled serigraph by Emanoel Araujo from 1987 measuring 70 x 200 cm.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/emanoel-araujo/sem-titulo-25632',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for an untitled woodcut by Emanoel Araujo from 1966 measuring 61 x 17 cm.',
      },
    ],
  },
  {
    artist: {
      full_name: 'Derlon',
      birthplace_city: 'Recife',
      birthplace_state: 'Pernambuco',
      visual_practice: 'muralism, printmaking, collage, painting',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Derlon and the Graphic Power of Print',
      subtitle:
        'From Recife to large-scale public walls, Derlon turns woodcut memory, urban rhythm, and Northeastern iconography into a bold contemporary language.',
      content: articleBody(
        `Derlon belongs to a generation of Brazilian artists who understand that popular visual culture is not a relic to be quoted from a distance, but a living grammar that can keep changing shape. Born in Recife, he built a practice that moves between mural painting, print logic, collage, and graphic intervention, always with a strong sense of public address. Even when his work enters institutional or exhibition spaces, it retains the clarity and directness of an image made to meet people in the street. That immediacy is part of what gives his art such force. The line is firm, the contrast is decisive, and the compositions seem to carry both the compression of printmaking and the expansion of urban scale.`,
        `The official material on Derlon's website frames his work through affection, memory, and identity, and those three words are a precise way to begin reading him. His vocabulary often draws on the visual memory of cordel, xilogravura, devotional imagery, and popular Northeastern ornament, but it never feels nostalgic or imitative. Instead, Derlon reorganizes those references into a contemporary field where graphic reduction becomes emotional intensity. Figures, animals, plants, and symbolic forms appear with a condensed, almost carved presence. The black-and-white discipline associated with woodcut remains a structural influence even when color enters the scene, because the work is always thinking through contour, contrast, and the charge of the silhouette.`,
        `His projects page makes that trajectory visible across different scales and contexts. Works and series such as Residência Artística Ceará, Mátria, and Ocupação Artística - Estes e Outros show an artist comfortable moving between exhibition formats, collaborative environments, and site-specific propositions. Meanwhile, the urban interventions page emphasizes how naturally his imagery operates in public space. Murals and pasted works do not simply enlarge a studio composition; they activate architecture, circulation, and neighborhood memory. This is where Derlon becomes especially compelling. He treats the wall not as a neutral support, but as a social surface where image, history, and movement can meet. That approach gives his work a rare balance: formally controlled, but never sealed off from life around it.`,
        `What makes Derlon important in the broader conversation about contemporary Brazilian art is this ability to connect regional inheritance to present-tense invention without flattening either side. He neither abandons the visual intelligence of popular traditions nor confines them to folklore. Instead, he pushes them into a sharper, riskier conversation with the contemporary city. The result is art that feels at once rooted and mobile, local and expansive. Derlon's best works show how print can become mural, how memory can become structure, and how a graphic language born in intimate formats can scale up without losing intimacy. That transformation is central to his achievement and a strong reason his work continues to resonate far beyond Pernambuco.`
      ),
    },
    images: [
      {
        url: 'https://static.wixstatic.com/media/26a73f_d1862dddf5244fb299c2cdc7503f9110~mv2.jpg/v1/fill/w_4865,h_3455,q_90,enc_avif,quality_auto/26a73f_d1862dddf5244fb299c2cdc7503f9110~mv2.jpg',
        caption: 'Murals',
        attribution: 'Derlon official website',
      },
      {
        url: 'https://static.wixstatic.com/media/26a73f_b90d16d875d8489a935a8cd44c1f0f09~mv2.jpg/v1/fit/w_4800,h_3200,q_75,enc_avif,quality_auto/26a73f_b90d16d875d8489a935a8cd44c1f0f09~mv2.jpg',
        caption: 'Residência Artística Ceará',
        attribution: 'Derlon official website',
      },
      {
        url: 'https://static.wixstatic.com/media/26a73f_14d0360201b8446e9253ea2fb32601df~mv2.jpg/v1/fit/w_4851,h_2129,q_75,enc_avif,quality_auto/26a73f_14d0360201b8446e9253ea2fb32601df~mv2.jpg',
        caption: 'Ocupação Artística - Estes e Outros',
        attribution: 'Derlon official website',
      },
    ],
    sources: [
      {
        url: 'https://www.derlon.com.br/',
        institution: 'Derlon official website',
        credibility_score: 0.98,
        content_summary:
          'Official artist website describing Derlon as a contemporary popular artist whose work is shaped by affection, memory, and identity, connecting printmaking, painting, muralism, and Brazilian popular visual culture.',
      },
      {
        url: 'https://www.derlon.com.br/projetos',
        institution: 'Derlon official website',
        credibility_score: 0.97,
        content_summary:
          'Official projects page documenting works and exhibitions including Residência Artística Ceará, Mátria, and Ocupação Artística - Estes e Outros, showing Derlon active across exhibitions, collaborations, and site-specific projects.',
      },
      {
        url: 'https://www.derlon.com.br/intervenções-urbanas',
        institution: 'Derlon official website',
        credibility_score: 0.97,
        content_summary:
          'Official urban interventions page highlighting Derlon’s mural and collage practice in public space, with large-scale graphic compositions informed by woodcut aesthetics and Northeastern visual memory.',
      },
    ],
  },
  {
    artist: {
      full_name: 'Cícero Dias',
      birthplace_city: 'Escada',
      birthplace_state: 'Pernambuco',
      visual_practice: 'painting',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Cícero Dias and the Dreamlike Memory of Pernambuco',
      subtitle:
        'A modernist from Escada who carried sugarcane landscapes, erotic freedom, and lyrical invention from Pernambuco into the center of Brazilian art.',
      content: articleBody(
        `Cícero Dias remains one of the key artists for understanding how Brazilian modernism could be both regional and radically open. Born in Escada, Pernambuco, in 1907, he transformed the remembered world of the sugar zone into a pictorial field full of sensuality, spatial drift, and imaginative freedom. What makes his work so striking is that memory never appears as static recollection. In his hands, childhood landscapes, bodies, plants, houses, and fragments of daily life are reorganized into fluid, dreamlike structures that feel suspended between autobiography and invention.`,
        `The biographical sources associated with this article place Dias at the center of several decisive artistic movements. He became linked to modernist circles early on, collaborated with the Revista de Antropofagia, and built a career that moved through Recife, Rio de Janeiro, Lisbon, and Paris. That trajectory matters because it shows how Pernambuco was not simply the origin he later left behind. It remained a visual and emotional reservoir that continued to feed the work even as his practice entered broader international conversations. The result is an art that never loses the heat of place, even when it grows more lyrical and formally adventurous.`,
        `The documented works Lembranças, Mãe e Filha, and Nu Feminino Com Flores help clarify the range of his language. The first title already points toward one of the deepest motors in Dias's work: remembrance as pictorial method. But these are not sentimental souvenirs. His figures and scenes feel airy, unstable, and unexpectedly free, as if memory itself were painting through association instead of chronology. Even when the image is intimate, there is a sense of expansion. Color opens the surface, line loosens description, and bodies become part of a broader emotional climate rather than isolated motifs.`,
        `What gives Cícero Dias lasting importance is this ability to make Northeastern experience legible within a modern idiom without flattening it into folklore. He did not abandon Pernambuco to become modern; he carried Pernambuco into modern art as a source of rhythm, image, and psychic space. That is why his work continues to resonate. It offers a version of Brazilian painting in which place is not a limit but a generative force, and in which memory becomes an engine for formal invention rather than a retreat into the past.`
      ),
    },
    images: [
      {
        url: 'https://www.escritoriodearte.com/quadro/cicero-dias-lembrancas-oleo-sobre-tela-24867g.webp',
        caption: 'Lembranças',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/cicero-dias-mae-e-filha-guache-sobre-papel-24866g.webp',
        caption: 'Mãe e Filha',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/cicero-dias-nu-feminino-com-flores-guache-sobre-papel-24865g.webp',
        caption: 'Nu Feminino Com Flores',
        attribution: 'Escritorio de Arte',
      },
    ],
    sources: [
      {
        url: 'https://www.escritoriodearte.com/artista/cicero-dias',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Cícero Dias (Escada, Pernambuco, 1907 - Paris, 2003) was a painter, printmaker, draftsman, illustrator, set designer, and teacher, recognized as a central figure in Brazilian modern art. He collaborated with the Revista de Antropofagia, exhibited the landmark panel Eu Vi o Mundo, worked between Recife, Rio, Lisbon, and Paris, and developed both figurative and lyrical abstract phases tied to Northeastern memory and color.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/cicero-dias/lembrancas-24867',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary: 'Lembranças by Cícero Dias, oil on canvas.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/cicero-dias/mae-e-filha-24866',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary: 'Mãe e Filha by Cícero Dias, gouache on paper.',
      },
    ],
  },
  {
    artist: {
      full_name: 'Reynaldo Fonseca',
      birthplace_city: 'Recife',
      birthplace_state: 'Pernambuco',
      visual_practice: 'painting',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Reynaldo Fonseca and the Quiet Strange of Brazilian Figuration',
      subtitle:
        'A painter from Recife whose dreamlike domestic scenes turned ordinary life into one of the most singular figurative worlds in Pernambuco art.',
      content: articleBody(
        `Reynaldo Fonseca's painting proves that figuration can be quietly unsettling without ever becoming theatrical. Born in Recife in 1925, he developed a body of work in which interiors, families, women, fruits, gestures, and everyday situations seem to hover between tenderness and estrangement. At first glance the paintings can appear calm, even courteous. But the longer one looks, the more they reveal an unusual psychological charge. Proportion shifts, silence thickens, and the ordinary begins to feel slightly suspended. That ability to disturb softly, rather than dramatically, is central to Fonseca's achievement.`,
        `The available biographical material places him within a strong lineage of Pernambuco art. He studied at the Escola de Belas Artes de Pernambuco, worked with Lula Cardoso Ayres, later studied with Candido Portinari in Rio de Janeiro, helped found the Sociedade de Arte Moderna do Recife, and taught drawing at the Federal University of Pernambuco. These details matter because they show a painter who was fully inside the institutional and intellectual development of modern art in the region, not a marginal eccentric working in isolation. Yet despite that grounding, Fonseca's work never reads as academic. It keeps a private, idiosyncratic atmosphere all its own.`,
        `The artworks documented here suggest some of the breadth of that sensibility. Figura Feminina condenses his attention to posture, stillness, and the emotional ambiguity of the human presence. Cortando o Cabelo turns a simple action into something theatrical without grand gestures, as if ritual had quietly entered domestic space. Cesta de Frutas, meanwhile, shows how even still life in Fonseca's hands can feel charged by arrangement, pause, and an almost narrative tension. He was not interested in mere description. He used figurative motifs as thresholds into mood, memory, and subtle dislocation.`,
        `That is why Reynaldo Fonseca remains such an important name in the visual history of Pernambuco. His paintings do not shout, but they linger. They create a world where intimacy and unease coexist, where drawing is precise but never dry, and where the familiar becomes newly strange without losing warmth. In an art history often organized around louder ruptures, Fonseca offers another kind of modernity: one built through atmosphere, ambiguity, and the patient transformation of daily life into enduring image.`
      ),
    },
    images: [
      {
        url: 'https://www.escritoriodearte.com/quadro/reynaldo-fonseca-figura-feminina-oleo-sobre-cartao-pincel-seco-19379g.webp',
        caption: 'Figura Feminina',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/reynaldo-fonseca-cortando-o-cabelo-oleo-sobre-tela-1766g.webp',
        caption: 'Cortando o Cabelo',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/reynaldo-fonseca-cesta-de-frutas-oleo-sobre-tela-1192g.webp',
        caption: 'Cesta de Frutas',
        attribution: 'Escritorio de Arte',
      },
    ],
    sources: [
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
    ],
  },
];

export class EmergencyFallbackModule {
  async prepareFallbackDraft(options: {
    minImages?: number;
    excludedArtistIds?: Set<number>;
  } = {}): Promise<EmergencyFallbackDraft | null> {
    const minImages = options.minImages ?? 3;
    const excludedArtistIds = options.excludedArtistIds ?? new Set<number>();

    for (const candidate of EMERGENCY_CANDIDATES) {
      const existingArtist = await artistOps.findByNormalizedName(candidate.artist.full_name);

      if (existingArtist?.id && excludedArtistIds.has(existingArtist.id)) {
        continue;
      }

      if (existingArtist?.status === 'published') {
        continue;
      }

      if (existingArtist?.id) {
        const existingDrafts = await draftOps.findByArtistId(existingArtist.id);
        const hasOpenOrUsedDraft = existingDrafts.some((draft) =>
          ['pending', 'sent', 'approved', 'rejected'].includes(draft.status)
        );

        if (hasOpenOrUsedDraft) {
          continue;
        }
      }

      const artistId = existingArtist?.id
        ? existingArtist.id
        : await artistOps.create({
            ...candidate.artist,
            status: 'verified',
            metadata: candidate.artist.metadata
              ? JSON.stringify(candidate.artist.metadata)
              : null,
          });

      if (existingArtist?.id && existingArtist.status !== 'verified') {
        await artistOps.updateStatus(existingArtist.id, 'verified');
      }

      for (const source of candidate.sources) {
        const exists = await sourceOps.exists(artistId, source.url);
        if (!exists) {
          await sourceOps.create({
            artist_id: artistId,
            ...source,
          });
        }
      }

      const draftId = await draftOps.create(
        {
          artist_id: artistId,
          title: candidate.article.title,
          subtitle: candidate.article.subtitle,
          content: candidate.article.content,
          status: 'pending',
        },
        candidate.images.slice(0, minImages)
      );

      return {
        sourceDraftId: draftId,
        draftId,
        artistId,
        artistName: candidate.artist.full_name,
        images: candidate.images.slice(0, minImages),
      };
    }

    return null;
  }
}
