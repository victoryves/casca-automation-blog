#!/usr/bin/env tsx

import axios from 'axios';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();

const HASHNODE_API = 'https://gql.hashnode.com';
const API_KEY = config.env.hashnodeApiKey!;

// Posts to delete (all duplicates)
const postsToDelete = [
  { id: '69888f70cbdab532a43760ef', title: 'Brennand v2' },
  { id: '69888ea69ca1f1307c2756e5', title: 'Brennand v3' },
  { id: '69888e9a9ca1f1307c2756e3', title: 'Cícero Dias v1' },
  { id: '69888d9cd1915939a0de85a9', title: 'Brennand v1' },
  { id: '69888b1ef87831f0d0fa0fba', title: 'Cícero Dias v2' },
];

async function deletePost(postId: string, title: string) {
  const mutation = `
    mutation RemovePost($id: ID!) {
      removePost(id: $id) {
        post {
          id
          title
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      HASHNODE_API,
      {
        query: mutation,
        variables: { id: postId },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: API_KEY,
        },
      }
    );

    if (response.data.errors) {
      console.error(`  ✗ Failed to delete ${title}:`, response.data.errors[0].message);
      return false;
    }

    console.log(`  ✓ Deleted: ${title}`);
    return true;
  } catch (error) {
    console.error(`  ✗ Error deleting ${title}:`, error);
    return false;
  }
}

async function cleanup() {
  console.log('🧹 Cleaning up duplicate Hashnode posts...\n');
  console.log(`Deleting ${postsToDelete.length} posts:\n`);

  let deleted = 0;
  for (const post of postsToDelete) {
    const success = await deletePost(post.id, post.title);
    if (success) deleted++;
    // Wait a bit between deletions
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`\n✅ Cleanup complete: ${deleted}/${postsToDelete.length} posts deleted`);
  console.log('\nKept: Francisco Brennand (final version)');
}

cleanup();
