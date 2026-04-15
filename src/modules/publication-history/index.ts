/**
 * Publication history helpers
 *
 * Uses public blog outputs as an external source of truth to avoid re-sending
 * artists that were already published outside the local draft lifecycle.
 * Successful fetches are cached locally so temporary RSS failures or rate limits
 * do not reopen artists that were already used.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface PublishedPostEntry {
  title: string;
  url: string;
  description?: string;
  content?: string;
}

interface PublicationHistoryCache {
  cached_at: string;
  entries: PublishedPostEntry[];
}

export class PublicationHistoryModule {
  private readonly rssCandidates: string[];
  private readonly hashnodeApiKey?: string;
  private readonly hashnodePublicationId?: string;
  private readonly hashnodePublicHost = 'casca.hashnode.dev';
  private readonly cachePath: string;

  constructor(options: {
    rssUrl?: string;
    hashnodeApiKey?: string;
    hashnodePublicationId?: string;
    cachePath?: string;
  }) {
    this.rssCandidates = [
      options.rssUrl,
      'https://brain.casca-archive.org/rss.xml',
      'https://casca.hashnode.dev/rss.xml',
    ].filter((value): value is string => Boolean(value));
    this.hashnodeApiKey = options.hashnodeApiKey;
    this.hashnodePublicationId = options.hashnodePublicationId;
    this.cachePath =
      options.cachePath ?? path.join(process.cwd(), 'data', 'publication-history-cache.json');
  }

  async getPublishedPostHaystacks(): Promise<string[]> {
    const cachedEntries = await this.readCachedEntries();
    const liveEntries = await this.fetchLiveEntries();
    const entries =
      liveEntries.length > 0
        ? this.mergeEntries(cachedEntries, liveEntries)
        : cachedEntries;

    if (liveEntries.length > 0) {
      await this.writeCachedEntries(entries);
    }

    return entries.map((entry) =>
      this.normalizeText(
        [entry.title, entry.url].join(' ')
      )
    );
  }

  private async fetchLiveEntries(): Promise<PublishedPostEntry[]> {
    const seen = new Set<string>();
    const entries: PublishedPostEntry[] = [];

    for (const rssUrl of this.rssCandidates) {
      try {
        const rssEntries = await this.fetchRssEntries(rssUrl);
        if (rssEntries.length === 0) {
          continue;
        }

        for (const entry of rssEntries) {
          const key = this.entryKey(entry);
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push(entry);
        }
      } catch {
        // Ignore RSS failures and fall through to the next source.
      }
    }

    if (entries.length > 0) {
      return entries;
    }

    const hashnodeEntries = await this.fetchHashnodeEntries();
    for (const entry of hashnodeEntries) {
      const key = this.entryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }

    return entries;
  }

  private mergeEntries(
    cachedEntries: PublishedPostEntry[],
    liveEntries: PublishedPostEntry[]
  ): PublishedPostEntry[] {
    const merged: PublishedPostEntry[] = [];
    const seen = new Set<string>();

    for (const entry of [...liveEntries, ...cachedEntries]) {
      const key = this.entryKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(entry);
    }

    return merged;
  }

  private async readCachedEntries(): Promise<PublishedPostEntry[]> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as PublicationHistoryCache;
      if (!parsed || !Array.isArray(parsed.entries)) {
        return [];
      }

      return parsed.entries.filter(
        (entry): entry is PublishedPostEntry =>
          Boolean(entry?.title?.trim()) && Boolean(entry?.url?.trim())
      );
    } catch {
      return [];
    }
  }

  private async writeCachedEntries(entries: PublishedPostEntry[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      const payload: PublicationHistoryCache = {
        cached_at: new Date().toISOString(),
        entries,
      };
      await fs.writeFile(this.cachePath, JSON.stringify(payload, null, 2));
    } catch {
      // Cache persistence is a resilience feature, so failures stay non-fatal.
    }
  }

  private async fetchRssEntries(rssUrl: string): Promise<PublishedPostEntry[]> {
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });

    const text = await response.text();
    if (!response.ok || !/<rss[\s>]|<feed[\s>]/i.test(text)) {
      return [];
    }

    const items = [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
    const entries: PublishedPostEntry[] = [];

    for (const item of items) {
      const block = item[0];
      const title = this.decodeXml(this.extractTag(block, 'title'));
      const link = this.decodeXml(this.extractTag(block, 'link'));
      if (!title || !link) continue;
      entries.push({
        title,
        url: link,
        description: this.cleanExcerpt(this.decodeXml(this.extractTag(block, 'description'))),
        content: this.cleanExcerpt(this.decodeXml(this.extractContentEncoded(block))),
      });
    }

    if (entries.length > 0) {
      return entries;
    }

    const atomEntries = [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];
    for (const entry of atomEntries) {
      const block = entry[0];
      const title = this.decodeXml(this.extractTag(block, 'title'));
      const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      const link = this.decodeXml(linkMatch?.[1] ?? '');
      if (!title || !link) continue;
      entries.push({
        title,
        url: link,
        description: this.cleanExcerpt(this.decodeXml(this.extractTag(block, 'summary'))),
        content: this.cleanExcerpt(this.decodeXml(this.extractTag(block, 'content'))),
      });
    }

    return entries;
  }

  private async fetchHashnodeEntries(): Promise<PublishedPostEntry[]> {
    const entries: PublishedPostEntry[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page++) {
      const usePrivateQuery = Boolean(this.hashnodeApiKey && this.hashnodePublicationId);
      const query = usePrivateQuery
        ? `
            query PublicationPosts($id: ObjectId!, $after: String) {
              publication(id: $id) {
                posts(first: 20, after: $after) {
                  edges {
                    node {
                      title
                      url
                      brief
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          `
        : `
            query PublicationByHost($host: String!, $after: String) {
              publication(host: $host) {
                posts(first: 20, after: $after) {
                  edges {
                    node {
                      title
                      url
                      brief
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          `;

      const response = await fetch('https://gql.hashnode.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.hashnodeApiKey ? { Authorization: this.hashnodeApiKey } : {}),
        },
        body: JSON.stringify({
          query,
          variables: usePrivateQuery
            ? {
                id: this.hashnodePublicationId,
                after: cursor,
              }
            : {
                host: this.hashnodePublicHost,
                after: cursor,
              },
        }),
      });

      if (!response.ok) {
        break;
      }

      const payload = (await response.json()) as {
        data?: {
          publication?: {
            posts?: {
              edges?: Array<{
                node?: { title?: string; url?: string; brief?: string | null } | null;
              }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          };
        };
      };

      const edges = payload.data?.publication?.posts?.edges ?? [];
      for (const edge of edges) {
        if (!edge.node?.title || !edge.node?.url) continue;
        entries.push({
          title: edge.node.title,
          url: edge.node.url,
          description: this.cleanExcerpt(edge.node.brief ?? ''),
        });
      }

      const pageInfo = payload.data?.publication?.posts?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        break;
      }

      cursor = pageInfo.endCursor;
    }

    return entries;
  }

  private extractTag(xml: string, tagName: string): string {
    const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    if (!match?.[1]) {
      return '';
    }

    return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/i, '$1').trim();
  }

  private extractContentEncoded(xml: string): string {
    const contentMatch = xml.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
    if (!contentMatch?.[1]) {
      return '';
    }

    return contentMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/i, '$1').trim();
  }

  private cleanExcerpt(value: string): string {
    return value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private decodeXml(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
  }

  private entryKey(entry: PublishedPostEntry): string {
    return `${entry.title}::${entry.url}`.toLowerCase();
  }
}
