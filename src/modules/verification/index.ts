/**
 * Verification Module
 *
 * Validates artist eligibility based on criteria:
 * - Visual artist from Northeast Brazil
 * - Minimum 2 trusted institutional sources
 * - Consistent biographical information
 */

import { artistOps, sourceOps } from '../../db/operations/index.js';
import { getConfig, getInstitutionCredibility } from '../../config/index.js';
import type { VerificationResult, Artist, Source } from '../../types/index.js';

export class VerificationModule {
  private readonly MIN_SOURCES = 2;
  private readonly MIN_SOURCES_HIGH_CREDIBILITY = 1;
  private readonly MIN_CREDIBILITY = 0.65;

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

  private readonly NORTHEAST_STATE_CODES = [
    'AL',
    'BA',
    'CE',
    'MA',
    'PB',
    'PE',
    'PI',
    'RN',
    'SE',
  ];

  // Terms that indicate this is NOT a person (exhibitions, institutions, etc.)
  private readonly EXCLUDED_TERMS = [
    'panorama',
    'bienal',
    'biennial',
    'exhibition',
    'exposição',
    'mostra',
    'museum',
    'museu',
    'gallery',
    'galeria',
    'instituto',
    'institute',
    'foundation',
    'fundação',
    'centro cultural',
    'cultural center',
    'list of',
    'lista de',
    'under the lens',
    'collection',
    'coleção',
    'dissertação',
    'dissertation',
    'mestrado',
    'master',
    'phd',
    'thesis',
    'tese',
    '.pdf',
    'arquivo',
    'document',
  ];

  /**
   * Verify a discovered artist
   */
  async verify(artistId: number): Promise<VerificationResult> {
    const artist = await artistOps.findById(artistId);
    if (!artist) {
      throw new Error(`Artist not found: ${artistId}`);
    }

    const sources = await sourceOps.findByArtistId(artistId);
    const reasons: string[] = [];
    let verified = true;

    console.log(`\n🔍 Verifying: ${artist.full_name}`);

    // Check 0: Is this actually a person? (not an event/exhibition/institution)
    const isActualPerson = this.isActualPerson(artist.full_name);
    if (!isActualPerson) {
      verified = false;
      reasons.push('Name appears to be an event, exhibition, or institution (not a person)');
      console.log(`  ✗ Not a person (event/exhibition/institution)`);
    } else {
      console.log(`  ✓ Appears to be a person`);
    }

    // Check 1: Minimum number of sources (flexible based on credibility)
    const highCredibilitySources = sources.filter((s) => s.credibility_score >= 0.9);
    const credibleSources = sources.filter((s) => s.credibility_score >= this.MIN_CREDIBILITY);
    const institutionalSources = sources.filter((source) => this.isInstitutionalSource(source));
    const premiumInstitutionalSources = institutionalSources.filter(
      (source) => this.getInstitutionalCredibility(source.url) >= 0.9
    );

    // Accept only when there is institutional support, not just marketplace/index coverage.
    const hasEnoughSources =
      premiumInstitutionalSources.length >= this.MIN_SOURCES_HIGH_CREDIBILITY ||
      (institutionalSources.length >= 1 && credibleSources.length >= this.MIN_SOURCES);

    if (!hasEnoughSources) {
      verified = false;
      reasons.push(
        `Insufficient institutional support (${sources.length} total, ${institutionalSources.length} institutional, ${premiumInstitutionalSources.length} premium institutional, ${credibleSources.length} credible)`
      );
      console.log(`  ✗ Insufficient sources: need 1 premium institutional source (0.9+) OR 1+ institutional + 2+ credible`);
      console.log(`    Got: ${institutionalSources.length} institutional, ${premiumInstitutionalSources.length} premium institutional, ${highCredibilitySources.length} high-credibility, ${credibleSources.length} credible`);
    } else {
      console.log(`  ✓ Sources: ${sources.length} (${institutionalSources.length} institutional, ${premiumInstitutionalSources.length} premium institutional, ${highCredibilitySources.length} high-credibility, ${credibleSources.length} credible)`);
    }

    if (verified && this.requiresPremiumInstitutionalSupport(artist, sources) && premiumInstitutionalSources.length === 0) {
      verified = false;
      reasons.push('Artist profile requires premium institutional validation, but none was found');
      console.log('  ✗ Weak-profile artist without premium institutional support');
    }

    // Check 3: Northeast Brazil origin (check sources if state is unknown)
    let isFromNortheast = this.isFromNortheast(artist);

    // If state unknown, check if sources mention Northeast states
    if (!isFromNortheast && !artist.birthplace_state) {
      isFromNortheast = this.sourcesIndicateNortheast(sources);
      if (isFromNortheast) {
        console.log(`  ✓ From Northeast Brazil (inferred from sources)`);
      }
    }

    if (!isFromNortheast) {
      verified = false;
      reasons.push(`Not from Northeast Brazil (state: ${artist.birthplace_state ?? 'unknown'})`);
      console.log(`  ✗ Not from Northeast Brazil`);
    } else {
      console.log(`  ✓ From Northeast Brazil: ${artist.birthplace_state ?? 'inferred'}`);
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
      await artistOps.updateStatus(artistId, 'verified');
      console.log(`  ✅ VERIFIED`);
    } else {
      console.log(`  ❌ REJECTED: ${reasons.join('; ')}`);
    }

    const refreshedArtist = await artistOps.findById(artistId);
    if (!refreshedArtist) {
      throw new Error(`Artist ${artistId} disappeared after verification`);
    }

    return {
      verified,
      artist: refreshedArtist,
      sources,
      reasons,
    };
  }

  /**
   * Check if sources mention Northeast states (for cases where artist.birthplace_state is unknown)
   */
  private sourcesIndicateNortheast(sources: Source[]): boolean {
    const northeastTerms = [
      'recife', 'salvador', 'fortaleza', 'natal', 'joão pessoa',
      'pernambuco', 'bahia', 'ceará', 'paraíba', 'alagoas',
      'sergipe', 'maranhão', 'piauí', 'rio grande do norte',
      'nordeste', 'northeast brazil'
    ];

    for (const source of sources) {
      const content = (source.content_summary ?? '').toLowerCase();
      const url = source.url.toLowerCase();

      for (const term of northeastTerms) {
        if (content.includes(term) || url.includes(term)) {
          return true;
        }
      }
    }

    return false;
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  /**
   * Check if the name appears to be an actual person (not an event/exhibition/institution)
   */
  private isActualPerson(name: string): boolean {
    const nameLower = name.toLowerCase();

    // Check for excluded terms
    for (const term of this.EXCLUDED_TERMS) {
      if (nameLower.includes(term)) {
        return false;
      }
    }

    // Additional heuristics:
    // - Should not end with common institutional suffixes
    if (nameLower.endsWith(' art') ||
        nameLower.endsWith(' arte') ||
        nameLower.endsWith(' artists') ||
        nameLower.endsWith(' artistas') ||
        nameLower.endsWith('.pdf')) {
      return false;
    }

    // - Should not start with numbers (like "36th" or "38th")
    if (/^\d+/.test(name)) {
      return false;
    }

    // - Should not contain file extensions
    if (/\.(pdf|doc|docx|txt)$/i.test(name)) {
      return false;
    }

    // - Should not be "List of..." or "Lista de..."
    if (nameLower.startsWith('list of') || nameLower.startsWith('lista de')) {
      return false;
    }

    // - Should have at least one space (person names have first + last name)
    // BUT allow single names if common in Brazilian art (like just "Vitalino")
    const wordCount = name.trim().split(/\s+/).length;
    if (wordCount === 0) {
      return false;
    }

    return true;
  }

  /**
   * Verify all discovered artists
   */
  async verifyAll(): Promise<VerificationResult[]> {
    const discovered = await artistOps.findByStatus('discovered');
    console.log(`\n📋 Verifying ${discovered.length} discovered artists...`);
    return this.verifyBatch(discovered.map((artist) => artist.id!).filter((id): id is number => typeof id === 'number'));
  }

  async verifyBatch(artistIds: number[]): Promise<VerificationResult[]> {
    console.log(`\n📋 Verifying ${artistIds.length} discovered artists...`);

    const results: VerificationResult[] = [];

    for (const artistId of artistIds) {
      try {
        const result = await this.verify(artistId);
        results.push(result);

        // Rate limiting
        await this.sleep(500);
      } catch (error) {
        console.error(`Error verifying artist ${artistId}:`, error);
      }
    }

    const verified = results.filter((r) => r.verified).length;
    console.log(`\n✓ Verification complete: ${verified}/${artistIds.length} verified`);

    return results;
  }

  /**
   * Check if artist is from Northeast Brazil
   */
  private isFromNortheast(artist: Artist): boolean {
    const normalizedState = this.normalizeText(artist.birthplace_state ?? '');
    if (!normalizedState) return false;

    if (
      this.NORTHEAST_STATES.some((state) =>
        normalizedState.includes(this.normalizeText(state))
      )
    ) {
      return true;
    }

    const tokens = normalizedState
      .replace(/[^a-z/,\s]+/g, ' ')
      .split(/[\s,/]+/)
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean);

    return tokens.some((token) => this.NORTHEAST_STATE_CODES.includes(token));
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
      'pintura',
      'painting',
      'escultor',
      'sculptor',
      'escultura',
      'sculpture',
      'artista visual',
      'visual artist',
      'fotógrafo',
      'photographer',
      'fotografia',
      'photography',
      'gravador',
      'printmaker',
      'gravura',
      'print',
      'xilogravura',
      'woodcut',
      'desenhista',
      'desenho',
      'drawing',
      'illustration',
      'ilustração',
      'instalação',
      'installation',
      'performance',
      'performance art',
      'mixed media',
      'arte contemporânea',
      'contemporary art',
      'cerâmica',
      'ceramic',
      'ceramista',
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

  private isInstitutionalSource(source: Source): boolean {
    return this.getInstitutionalCredibility(source.url) >= 0.85;
  }

  private getInstitutionalCredibility(url: string): number {
    return getInstitutionCredibility(url, getConfig().institutions);
  }

  private requiresPremiumInstitutionalSupport(artist: Artist, sources: Source[]): boolean {
    const normalizedPractice = (artist.visual_practice ?? '').toLowerCase();
    const fragilePractice =
      normalizedPractice.includes('arte urbana') ||
      normalizedPractice.includes('street art') ||
      normalizedPractice.includes('grafite') ||
      normalizedPractice.includes('graffiti') ||
      normalizedPractice.includes('quadrinho') ||
      normalizedPractice.includes('hq') ||
      normalizedPractice.includes('comic') ||
      normalizedPractice.includes('digital') ||
      normalizedPractice.includes('ilustração') ||
      normalizedPractice.includes('illustration');

    if (fragilePractice) {
      return true;
    }

    const allContent = sources.map((source) => (source.content_summary ?? '').toLowerCase()).join(' ');
    return (
      allContent.includes('street art') ||
      allContent.includes('arte urbana') ||
      allContent.includes('graffiti') ||
      allContent.includes('digital art') ||
      allContent.includes('illustration')
    );
  }
}
