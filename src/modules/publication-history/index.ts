/**
 * Publication history helpers
 *
 * Uses public blog outputs as an external source of truth to avoid re-sending
 * artists that were already published outside the local draft lifecycle.
 */

interface PublishedPostEntry {
  title: string;
  url: string;
}

export class PublicationHistoryModule {
  private readonly rssCandidates: string[];
  private readonly hashnodeApiKey?: string;
  private readonly hashnodePublicationId?: string;

  constructor(options: {
    rssUrl?: string;
    hashnodeApiKey?: string;
    hashnodePublicationId?: string;
  }) {
    this.rssCandidates = [
      options.rssUrl,
      'https://brain.casca-archive.org/rss.xml',
      'https://casca.hashnode.dev/rss.xml',
    ].filter((value): value is string => Boolean(value));
    this.hashnodeApiKey = options.hashnodeApiKey;
    this.hashnodePublicationId = options.hashnodePublicationId;
  }

  async getPublishedPostHaystacks(): Promise<string[]> {
    const seen = new Set<string>();
    const entries: PublishedPostEntry[] = [];

    for (const rssUrl of this.rssCandidates) {
      try {
        const rssEntries = await this.fetchRssEntries(rssUrl);
        if (rssEntries.length > 0) {
          for (const entry of rssEntries) {
            const key = `${entry.title}::${entry.url}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push(entry);
          }
          break;
        }
      } catch {
        // Ignore RSS failures and fall through to the next source.
      }
    }

    if (entries.length === 0) {
      const hashnodeEntries = await this.fetchHashnodeEntries();
      for (const entry of hashnodeEntries) {
        const key = `${entry.title}::${entry.url}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }

    return entries.map((entry) => this.normalizeText(`${entry.title} ${entry.url}`));
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
      entries.push({ title, url: link });
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
      entries.push({ title, url: link });
    }

    return entries;
  }

  private async fetchHashnodeEntries(): Promise<PublishedPostEntry[]> {
    if (!this.hashnodeApiKey || !this.hashnodePublicationId) {
      return [];
    }

    const entries: PublishedPostEntry[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page++) {
      const query = `
        query PublicationPosts($id: ObjectId!, $after: String) {
          publication(id: $id) {
            posts(first: 20, after: $after) {
              edges {
                node {
                  title
                  url
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
          Authorization: this.hashnodeApiKey,
        },
        body: JSON.stringify({
          query,
          variables: {
            id: this.hashnodePublicationId,
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
              edges?: Array<{ node?: PublishedPostEntry | null }>;
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
}
