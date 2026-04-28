import axios from 'axios';

export type WikiScoutCandidate = {
  title: string;
  url: string;
  description?: string;
  source_page: string;
  reported_width?: number;
  reported_height?: number;
};

export class WikiScout {
  async findArtistImages(artistName: string, limit = 10): Promise<WikiScoutCandidate[]> {
    try {
      const exactName = artistName.trim();
      const params = new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: `"${exactName}"`,
        gsrnamespace: '6',
        gsrlimit: String(Math.min(Math.max(limit, 1), 20)),
        prop: 'imageinfo',
        iiprop: 'url|size',
        format: 'json',
        origin: '*',
      });

      const response = await axios.get(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
        timeout: 20000,
        headers: {
          'User-Agent': 'CASCA-Editorial-Agent/1.0',
        },
      });

      const pages = response.data?.query?.pages;
      if (!pages || typeof pages !== 'object') {
        return [];
      }

      const images: WikiScoutCandidate[] = [];

      for (const page of Object.values(pages) as any[]) {
        const info = page?.imageinfo?.[0];
        if (!info?.url) continue;
        const title = String(page.title ?? '');
        images.push({
          title,
          url: String(info.url),
          description: title.replace(/^File:/i, '').replace(/[_-]+/g, ' '),
          source_page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`,
          reported_width: Number(info.width ?? 0) || undefined,
          reported_height: Number(info.height ?? 0) || undefined,
        });
        if (images.length >= limit) break;
      }

      return images;
    } catch (error) {
      console.warn('WikiScout search failed:', error);
      return [];
    }
  }
}
