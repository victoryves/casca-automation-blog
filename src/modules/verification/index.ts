/**
 * Verification Module
 *
 * Validates artist eligibility based on criteria:
 * - Visual artist from Northeast Brazil
 * - Minimum 2 trusted institutional sources
 * - Consistent biographical information
 */

import { artistOps, sourceOps } from '../../db/operations/index.js';
import type { VerificationResult, Artist, Source } from '../../types/index.js';

export class VerificationModule {
  private readonly MIN_SOURCES = 2;
  private readonly MIN_CREDIBILITY = 0.5;

  // Northeast Brazil states
  private readonly NORTHEAST_STATES = [
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

  /**
   * Verify a discovered artist
   */
  async verify(artistId: number): Promise<VerificationResult> {
    const artist = artistOps.findById(artistId);
    if (!artist) {
      throw new Error(`Artist not found: ${artistId}`);
    }

    const sources = sourceOps.findByArtistId(artistId);
    const reasons: string[] = [];
    let verified = true;

    console.log(`\n🔍 Verifying: ${artist.full_name}`);

    // Check 1: Minimum number of sources
    if (sources.length < this.MIN_SOURCES) {
      verified = false;
      reasons.push(`Insufficient sources (${sources.length}/${this.MIN_SOURCES})`);
      console.log(`  ✗ Insufficient sources: ${sources.length}/${this.MIN_SOURCES}`);
    } else {
      console.log(`  ✓ Sources: ${sources.length}/${this.MIN_SOURCES}`);
    }

    // Check 2: Source credibility
    const credibleSources = sources.filter((s) => s.credibility_score >= this.MIN_CREDIBILITY);
    if (credibleSources.length < this.MIN_SOURCES) {
      verified = false;
      reasons.push(
        `Insufficient credible sources (${credibleSources.length}/${this.MIN_SOURCES})`
      );
      console.log(
        `  ✗ Credible sources: ${credibleSources.length}/${this.MIN_SOURCES}`
      );
    } else {
      console.log(`  ✓ Credible sources: ${credibleSources.length}`);
    }

    // Check 3: Northeast Brazil origin
    const isFromNortheast = this.isFromNortheast(artist);
    if (!isFromNortheast) {
      verified = false;
      reasons.push(`Not from Northeast Brazil (state: ${artist.birthplace_state ?? 'unknown'})`);
      console.log(`  ✗ Not from Northeast Brazil`);
    } else {
      console.log(`  ✓ From Northeast Brazil: ${artist.birthplace_state}`);
    }

    // Check 4: Visual artist classification
    const isVisualArtist = this.isVisualArtist(artist, sources);
    if (!isVisualArtist) {
      verified = false;
      reasons.push('Could not confirm visual artist classification');
      console.log(`  ✗ Visual artist classification unclear`);
    } else {
      console.log(`  ✓ Visual artist confirmed`);
    }

    // Check 5: Data consistency
    const consistency = this.checkConsistency(sources);
    if (!consistency.consistent) {
      // Warning but not failure
      reasons.push(`Potential inconsistencies: ${consistency.issues.join(', ')}`);
      console.log(`  ⚠ Data inconsistencies detected`);
    } else {
      console.log(`  ✓ Data consistent across sources`);
    }

    // Update artist status
    if (verified) {
      artistOps.updateStatus(artistId, 'verified');
      console.log(`  ✅ VERIFIED`);
    } else {
      console.log(`  ❌ REJECTED: ${reasons.join('; ')}`);
    }

    return {
      verified,
      artist: artistOps.findById(artistId)!, // Re-fetch with updated status
      sources,
      reasons,
    };
  }

  /**
   * Verify all discovered artists
   */
  async verifyAll(): Promise<VerificationResult[]> {
    const discovered = artistOps.findByStatus('discovered');
    console.log(`\n📋 Verifying ${discovered.length} discovered artists...`);

    const results: VerificationResult[] = [];

    for (const artist of discovered) {
      try {
        const result = await this.verify(artist.id!);
        results.push(result);

        // Rate limiting
        await this.sleep(500);
      } catch (error) {
        console.error(`Error verifying artist ${artist.id}:`, error);
      }
    }

    const verified = results.filter((r) => r.verified).length;
    console.log(`\n✓ Verification complete: ${verified}/${discovered.length} verified`);

    return results;
  }

  /**
   * Check if artist is from Northeast Brazil
   */
  private isFromNortheast(artist: Artist): boolean {
    if (!artist.birthplace_state) return false;

    return this.NORTHEAST_STATES.some((state) =>
      artist.birthplace_state!.toLowerCase().includes(state.toLowerCase())
    );
  }

  /**
   * Check if artist is a visual artist
   */
  private isVisualArtist(artist: Artist, sources: Source[]): boolean {
    // Check artist practice
    if (artist.visual_practice) return true;

    // Check source content for visual art keywords
    const visualArtKeywords = [
      'pintor',
      'painter',
      'escultor',
      'sculptor',
      'artista visual',
      'visual artist',
      'fotógrafo',
      'photographer',
      'gravador',
      'printmaker',
      'desenhista',
      'drawing',
      'obra de arte',
      'artwork',
      'exposição',
      'exhibition',
      'galeria',
      'gallery',
      'museu',
      'museum',
    ];

    const allContent = sources.map((s) => s.content_summary?.toLowerCase() ?? '').join(' ');

    return visualArtKeywords.some((keyword) => allContent.includes(keyword.toLowerCase()));
  }

  /**
   * Check data consistency across sources
   */
  private checkConsistency(sources: Source[]): { consistent: boolean; issues: string[] } {
    const issues: string[] = [];

    if (sources.length < 2) {
      return { consistent: true, issues: [] };
    }

    // Check for conflicting information patterns
    // This is a simplified check - could be enhanced with NLP

    const urls = sources.map((s) => s.url);
    const uniqueDomains = new Set(urls.map((url) => new URL(url).hostname));

    if (uniqueDomains.size === 1 && sources.length > 1) {
      issues.push('All sources from same domain');
    }

    return {
      consistent: issues.length === 0,
      issues,
    };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
