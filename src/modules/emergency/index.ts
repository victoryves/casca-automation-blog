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
      full_name: 'Jenner Augusto',
      birthplace_city: 'Aracaju',
      birthplace_state: 'Sergipe',
      visual_practice: 'painting, drawing, printmaking, illustration',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Jenner Augusto and the Social Landscape of Bahia',
      subtitle:
        'From Sergipe to Salvador, Jenner Augusto transformed workers, shorelines, and urban life into a modern painting language of volume, light, and empathy.',
      content: articleBody(
        `Jenner Augusto occupies an important place in Brazilian modern art because he joined social feeling to painterly construction without reducing either one. Born in Aracaju in 1924 and later deeply associated with Bahia, he moved through painting, drawing, printmaking, and illustration while building a body of work marked by human density, regional atmosphere, and strong compositional structure. His career connected Sergipe, Salvador, Rio de Janeiro, and international exhibitions, but his work never lost contact with the everyday life of Northeastern Brazil.`,
        `What stands out in Jenner Augusto is the way landscape and social experience remain intertwined. The biographical material links him to depictions of Alagados, coastal scenes, city views, and popular life, all treated with a modern sensibility that balances geometry and emotion. Even when the forms become simplified, the pictures retain weight and presence. His paintings do not merely record a setting; they reorganize it into a field of color, volume, and rhythm, making place feel lived rather than decorative.`,
        `The works available here help clarify that range. Marinha shows Jenner's ability to turn the coast into a structured, luminous surface. Serra de Itabaiana reveals how he could monumentalize a regional landscape without losing its atmosphere. Paisagem, preserved through a historical artwork image, points to the broader continuity of his vision: a painting language rooted in land, weather, and human experience, but refined through modern design and disciplined color.`,
        `Jenner Augusto matters because he helped shape a modern visual identity for Bahia and the Northeast that was neither provincial nor detached from local life. His work demonstrates that regional subject matter can sustain ambitious formal invention, and that painting can carry both social memory and compositional intelligence at once. Looking at Jenner today, one sees an artist who understood how to make landscape and people resonate within the same durable image.`
      ),
    },
    images: [
      {
        url: 'https://www.escritoriodearte.com/quadro/jenner-augusto-marinha-oleo-sobre-tela-26427g.webp',
        caption: 'Marinha, oil on canvas',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/jenner-augusto-serra-de-itabaiana-oleo-sobre-tela-26393g.webp',
        caption: 'Serra de Itabaiana, oil on canvas',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/jenner-augusto-paisagem-oleo-sobre-tela-23376g.webp',
        caption: 'Paisagem, oil on canvas',
        attribution: 'Escritorio de Arte',
      },
    ],
    sources: [
      {
        url: 'https://www.escritoriodearte.com/artista/jenner-augusto',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Biographical page for Jenner Augusto describing his trajectory from Sergipe to Bahia, his work as painter, illustrator, printmaker, and his connection to landscapes, Alagados, and modern Bahian art.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/jenner-augusto/marinha-26427',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for Marinha, an oil on canvas by Jenner Augusto.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/jenner-augusto/serra-de-itabaiana-26393',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for Serra de Itabaiana, an oil on canvas by Jenner Augusto.',
      },
    ],
  },
  {
    artist: {
      full_name: 'Antônio Bandeira',
      birthplace_city: 'Fortaleza',
      birthplace_state: 'Ceará',
      visual_practice: 'painting, drawing, printmaking',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Antônio Bandeira and the Electric Weather of Brazilian Abstraction',
      subtitle:
        'From Fortaleza to Paris, Bandeira turned cities, forests, and pure sensation into one of the most lyrical painting languages of modern Brazil.',
      content: articleBody(
        `Antônio Bandeira remains one of the essential figures of Brazilian modernism because he made painting feel simultaneously atmospheric and structural. Born in Fortaleza in 1922, he moved from early figurative work toward a dazzling abstract language shaped by luminous color, nervous line, and a deep sensitivity to rhythm. His career unfolded between Ceará, Rio de Janeiro, and Paris, and that circulation mattered: Bandeira absorbed international debates around lyrical abstraction without ever flattening his work into imitation. Even at its most nonfigurative, his painting keeps the pulse of landscape, weather, city, and memory.`,
        `What makes Bandeira so compelling is the way he lets form hover between recognition and dissolution. In works tied to cities, forests, and mineral surfaces, the image never settles into a closed description. Instead, color seems to flicker into fragments, as if the canvas were registering light in motion rather than a fixed scene. That quality helps explain why he became such a singular colorist. His paintings do not simply depict atmosphere; they behave like atmosphere. Space opens through streaks, stains, bursts, and chromatic vibration, producing pictures that feel alive with movement even when they remain internally disciplined.`,
        `The available works gathered here make that range visible. Cidade condenses urban experience into a mesh of glowing marks and architectural tension. Floresta de Carnaúba shows how Bandeira could transform a regional landscape into something almost cosmic without losing its rootedness. Ferro, meanwhile, demonstrates the strength of his later abstraction, where material sensation and compositional control push against each other with remarkable energy. Across these works, his gift is clear: he can suggest place, structure, and emotion without locking the viewer into a single reading.`,
        `Bandeira's importance goes beyond being an early abstract painter from Ceará. He proved that Brazilian abstraction could be sensuous, local, and internationally ambitious at once. His work moves between lyricism and construction, between memory of the visible world and the freedom of painterly invention. That tension gives his paintings their lasting force. Looking at Antônio Bandeira today, one sees not a footnote to European modernism, but a painter who turned color and gesture into a language unmistakably his own.`
      ),
    },
    images: [
      {
        url: 'https://mais.opovo.com.br/_midias/jpg/2022/05/18/750x500/1_01__crepusculo__iab_0215___ano_1966-18776661.jpg',
        caption: 'Crepúsculo, mixed technique on canvas, 1966',
        attribution: 'O POVO+',
      },
      {
        url: 'https://mais.opovo.com.br/_midias/jpg/2022/05/18/04__floresta_de_carnauba_iab__1007-18776681.jpg',
        caption: 'Floresta de Carnaúba, oil on canvas, 1951',
        attribution: 'O POVO+',
      },
      {
        url: 'https://mais.opovo.com.br/_midias/jpg/2022/05/18/750x500/1_05__ferro_iab__1003-18776686.jpg',
        caption: 'Ferro, oil on canvas, 1961',
        attribution: 'O POVO+',
      },
    ],
    sources: [
      {
        url: 'https://mais.opovo.com.br/reportagens-especiais/2022/05/23/centenario-de-antonio-bandeira-um-artista-do-ceara-e-do-mundo.html',
        institution: 'O POVO+',
        credibility_score: 0.92,
        content_summary:
          'Long-form centenary feature on Antônio Bandeira with biographical context, critical essays, and multiple reproduced artworks including Crepúsculo, Floresta de Carnaúba, Samba na Roça, and Ferro.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/antonio-bandeira/cidade-18260',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for Cidade, an oil on canvas by Antônio Bandeira, reinforcing his abstract urban vocabulary and market-documented oeuvre.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/antonio-bandeira/sem-titulo-9095',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for Sem Título, an oil on canvas by Antônio Bandeira, documenting another example of his lyrical abstraction.',
      },
    ],
  },
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
      full_name: 'Aldemir Martins',
      birthplace_city: 'Ingazeiras',
      birthplace_state: 'Ceará',
      visual_practice: 'painting, drawing, printmaking',
      metadata: {
        source: 'emergency_fallback_catalog',
      },
    },
    article: {
      title: 'Aldemir Martins and the Animal Grammar of Brazilian Modernism',
      subtitle:
        'From Ceará to the center of Brazilian visual culture, Aldemir Martins turned cats, birds, flowers, and fruits into a vivid language of contour and color.',
      content: articleBody(
        `Aldemir Martins built one of the most immediately recognizable bodies of work in modern Brazilian art because he understood how repetition can become invention rather than formula. Born in Ingazeiras, Ceará, in 1922, he transformed familiar motifs such as cats, roosters, fish, flowers, and still lifes into a visual language of tensile line, flattened volume, and saturated chromatic force. His art is popular without being simplistic, graphic without becoming cold, and modern without severing itself from lived experience. That balance is one reason his work still circulates so powerfully across audiences of very different backgrounds.`,
        `What distinguishes Martins is the way he compresses observation into emblem. He does not describe the world in a naturalistic way; he distills it until the image reaches maximum clarity. A flower becomes an explosion of silhouette and hue. A bowl of fruit becomes a concentrated theater of curves, density, and balance. Even untitled works tend to preserve this same economy. He was able to reduce without emptying, stylize without thinning out emotion, and simplify form while making the picture feel more alive rather than less. That is the core of his achievement.`,
        `The works documented here make that language especially visible. The watercolor listed as Sem Título shows how spare means can still produce tension, lyricism, and formal bite. Flor demonstrates Martins's command of decorative structure, where color blocks and contour lock together with extraordinary precision. Frutas reveals another dimension of his sensibility: the transformation of ordinary still-life material into a charged visual field built from rhythm and compression rather than illusionistic depth. Across these works, the same artistic intelligence is clear. He makes the image legible at once, but never exhausted at first glance.`,
        `Aldemir Martins remains important because he proved that a distinctly Brazilian modernism could be bold, accessible, and formally rigorous at the same time. He did not need obscurity to achieve complexity. Instead, he relied on structure, contour, and color to produce images that enter memory quickly and stay there. Looking at his work, one sees an artist who knew exactly how far simplification could go before it stopped being alive, and who kept every line under pressure until it carried both visual pleasure and durable identity.`
      ),
    },
    images: [
      {
        url: 'https://www.escritoriodearte.com/quadro/aldemir-martins-sem-titulo-aquarela-sobre-papel-26355g.webp',
        caption: 'Sem Título, watercolor on paper',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/aldemir-martins-flor-serigrafia-26352g.webp',
        caption: 'Flor, serigraph',
        attribution: 'Escritorio de Arte',
      },
      {
        url: 'https://www.escritoriodearte.com/quadro/aldemir-martins-frutas-serigrafia-26350g.webp',
        caption: 'Frutas, serigraph',
        attribution: 'Escritorio de Arte',
      },
    ],
    sources: [
      {
        url: 'https://www.escritoriodearte.com/artista/aldemir-martins',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Biographical and market overview for Aldemir Martins, the artist from Ceará widely recognized for his modern Brazilian paintings, drawings, and prints centered on animals, flowers, fruits, and graphic stylization.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/aldemir-martins/sem-titulo-26355',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for an untitled watercolor on paper by Aldemir Martins.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/aldemir-martins/flor-26352',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for Flor, a serigraph by Aldemir Martins.',
      },
      {
        url: 'https://www.escritoriodearte.com/artista/aldemir-martins/frutas-26350',
        institution: 'Escritorio de Arte',
        credibility_score: 0.9,
        content_summary:
          'Artwork listing for Frutas, a serigraph by Aldemir Martins.',
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
