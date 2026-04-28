/**
 * Candidate Extractor
 *
 * Extracts artist candidate information from search results.
 */

import type { SearchResult, Artist, Source } from '../../types/index.js';

export interface ExtractedCandidate {
  artist: Omit<Artist, 'id'>;
  sources: Omit<Source, 'id' | 'artist_id'>[];
}

export class CandidateExtractor {
  /**
   * Extract artist candidates from search results
   */
  extract(results: SearchResult[]): ExtractedCandidate[] {
    const candidates: ExtractedCandidate[] = [];

    for (const result of results) {
      try {
        const candidate = this.extractFromResult(result);
        if (candidate) {
          candidates.push(candidate);
        }
      } catch (error) {
        console.warn('Failed to extract candidate:', error);
      }
    }

    return candidates;
  }

  /**
   * Extract candidate from a single search result
   */
  private extractFromResult(result: SearchResult): ExtractedCandidate | null {
    // Extract artist name from title (common patterns)
    const name = this.extractArtistName(result.title);
    if (!name) return null;

    // Extract location info from content
    const location = this.extractLocation(result.content);

    // Create candidate
    const artist: Omit<Artist, 'id'> = {
      full_name: name,
      birthplace_city: location?.city,
      birthplace_state: location?.state,
      visual_practice: this.extractPractice(result.content),
      status: 'discovered',
      metadata: JSON.stringify({
        search_title: result.title,
        published_date: result.published_date,
      }),
    };

    const source: Omit<Source, 'id' | 'artist_id'> = {
      url: result.url,
      institution: this.extractInstitution(result.url),
      credibility_score: result.score ?? 0.5,
      content_summary: result.content.substring(0, 500),
    };

    return { artist, sources: [source] };
  }

  /**
   * Extract artist name from title
   */
  private extractArtistName(title: string): string | null {
    // Remove common prefixes
    const cleaned = title
      .replace(/^(artist|artista|painter|pintor|sculptor|escultor):\s*/i, '')
      .replace(/\s*[-–—]\s*.+$/, '') // Remove subtitle after dash
      .trim();

    // Basic validation
    if (cleaned.length < 3 || cleaned.length > 100) return null;
    if (!/[a-zA-ZÀ-ÿ]/.test(cleaned)) return null;

    return cleaned;
  }

  /**
   * Extract location information
   */
  private extractLocation(content: string): { city?: string; state?: string } | null {
    // Northeast Brazil states
    const neStates = [
      'Alagoas',
      'Bahia',
      'Ceará',
      'Maranhão',
      'Paraíba',
      'Pernambuco',
      'Piauí',
      'Rio Grande do Norte',
      'Sergipe',
    ];

    const location: { city?: string; state?: string } = {};

    // Look for state mentions
    for (const state of neStates) {
      const regex = new RegExp(`\\b${state}\\b`, 'i');
      if (regex.test(content)) {
        location.state = state;
        break;
      }
    }

    // Look for common city patterns
    const cityMatch = content.match(/\b(nascido|nascida|born|from)\s+(?:em|in)\s+([A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+)?)/i);
    if (cityMatch?.[2]) {
      location.city = cityMatch[2].trim();
    }

    return Object.keys(location).length > 0 ? location : null;
  }

  /**
   * Extract visual practice/medium
   */
  private extractPractice(content: string): string | undefined {
    const practices = [
      'painting',
      'pintura',
      'sculpture',
      'escultura',
      'photography',
      'fotografia',
      'drawing',
      'desenho',
      'printmaking',
      'gravura',
      'installation',
      'instalação',
      'performance',
      'video art',
      'videoarte',
    ];

    for (const practice of practices) {
      const regex = new RegExp(`\\b${practice}\\b`, 'i');
      if (regex.test(content)) {
        return practice.toLowerCase();
      }
    }

    return undefined;
  }

  /**
   * Extract institution name from URL
   */
  private extractInstitution(url: string): string {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.replace(/^www\./, '');
      return hostname;
    } catch {
      return 'unknown';
    }
  }
}
