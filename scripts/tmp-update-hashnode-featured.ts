import dotenv from 'dotenv';
import path from 'node:path';
import { PublishingModule } from '../src/modules/publishing/index.js';
import { draftOps, sourceOps } from '../src/db/operations/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

async function main() {
  initDatabase();
  const postId = '69f0e45ec972253f06b493b3';
  const featuredIndex = 1;
  const draft = await draftOps.findById(107);
  if (!draft) throw new Error('draft 107 missing');

  const images = draft.images ? JSON.parse(draft.images) : [];
  const coverImage = images[featuredIndex] ?? images[0];
  const contentImages = images.filter((_: unknown, index: number) => index !== featuredIndex);
  const sources = await sourceOps.findByArtistId(draft.artist_id);

  const publishing = new PublishingModule(process.env.HASHNODE_API_KEY!, process.env.HASHNODE_PUBLICATION_ID!);
  const contentMarkdown = await (publishing as any).generateHashnodeContent(
    draft,
    'Ismael Nery',
    contentImages,
    sources,
    coverImage
  );
  const coverImageURL = (publishing as any).buildCoverImageUrl(coverImage.url);

  const mutation = `
    mutation UpdatePost($input: UpdatePostInput!) {
      updatePost(input: $input) {
        post {
          id
          title
          url
          slug
        }
      }
    }
  `;

  const variables = {
    input: {
      id: postId,
      title: draft.title,
      subtitle: draft.subtitle || undefined,
      contentMarkdown,
      coverImageOptions: {
        coverImageURL,
        coverImageAttribution: coverImage.attribution,
      },
      slug: 'ismael-nery-high-contrast-cubism-surrealist-visions',
      settings: {
        delisted: false,
      },
    },
  };

  const response = await fetch('https://gql.hashnode.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.HASHNODE_API_KEY!,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const json = await response.json();
  console.log(JSON.stringify(json, null, 2));
  closeDatabase();
}

main().catch((err) => {
  console.error(err);
  closeDatabase();
  process.exit(1);
});
