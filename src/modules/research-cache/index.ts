import fs from 'node:fs/promises';
import path from 'node:path';

export interface BiographyResearchSource {
  url: string;
  title: string;
  institution: string;
  credibilityScore: number;
  extractor: string;
  contentLength: number;
  summary: string;
}

export interface ArtworkResearchCandidate {
  pageUrl: string;
  imageUrl?: string;
  title: string;
  sourceDomain: string;
  sourceType: 'source-page' | 'image-search';
  confidence: number;
}

export interface RepetitionStatus {
  publishedExternally: boolean;
  localArtistStatus?: string | null;
  draftStatuses: string[];
  eligible: boolean;
  matchedVariant?: string | null;
}

export interface ArtistResearchCacheEntry {
  artistName: string;
  states?: string;
  practice?: string;
  category?: string;
  shortlistRank?: number;
  minedAt: string;
  repetition: RepetitionStatus;
  biographySources: BiographyResearchSource[];
  artworkCandidates: ArtworkResearchCandidate[];
  notes: string[];
}

interface ArtistResearchCacheFile {
  updatedAt: string;
  entries: ArtistResearchCacheEntry[];
}

export class ArtistResearchCache {
  constructor(
    private readonly cachePath = path.join(process.cwd(), 'data', 'artist-research-cache.json')
  ) {}

  async readAll(): Promise<ArtistResearchCacheEntry[]> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as ArtistResearchCacheFile;
      if (!parsed || !Array.isArray(parsed.entries)) {
        return [];
      }
      return parsed.entries;
    } catch {
      return [];
    }
  }

  async findByArtistName(artistName: string): Promise<ArtistResearchCacheEntry | null> {
    const normalizedTarget = this.normalizeArtistName(artistName);
    const entries = await this.readAll();
    return (
      entries.find((entry) => this.normalizeArtistName(entry.artistName) === normalizedTarget) ?? null
    );
  }

  async upsert(entry: ArtistResearchCacheEntry): Promise<void> {
    const entries = await this.readAll();
    const normalizedTarget = this.normalizeArtistName(entry.artistName);
    const nextEntries = entries.filter(
      (existing) => this.normalizeArtistName(existing.artistName) !== normalizedTarget
    );
    nextEntries.push(entry);
    nextEntries.sort((a, b) => a.artistName.localeCompare(b.artistName, 'pt-BR'));
    await this.writeAll(nextEntries);
  }

  async writeAll(entries: ArtistResearchCacheEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    const payload: ArtistResearchCacheFile = {
      updatedAt: new Date().toISOString(),
      entries,
    };
    await fs.writeFile(this.cachePath, JSON.stringify(payload, null, 2));
  }

  private normalizeArtistName(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }
}
