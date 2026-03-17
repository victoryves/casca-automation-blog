/**
 * Workflow Orchestrator
 *
 * Main workflow coordinator for daily execution.
 */

import { initDatabase, closeDatabase } from '../db/supabase.js';
import { artistOps, draftOps, sourceOps } from '../db/operations/index.js';
import { getConfig } from '../config/index.js';
import { DiscoveryModule } from '../modules/discovery/index.js';
import { VerificationModule } from '../modules/verification/index.js';
import { SynthesisModule } from '../modules/synthesis/index.js';
import { VisualModule } from '../modules/visual/index.js';
import { EmailModule } from '../modules/email/index.js';
import { PublishingModule } from '../modules/publishing/index.js';
import { ScraperBridge } from '../modules/scraper-bridge/index.js';
import { Logger } from '../utils/logger.js';
import type { WorkflowState, Artist } from '../types/index.js';

export interface WorkflowOptions {
  dryRun?: boolean;
  skipDiscovery?: boolean;
  forceRun?: boolean;
}

export class WorkflowOrchestrator {
  private logger: Logger;
  private config: ReturnType<typeof getConfig>;

  constructor() {
    this.config = getConfig();
    this.logger = new Logger('./logs', this.config.env.logLevel);
  }

  /**
   * Execute daily workflow
   */
  async execute(options: WorkflowOptions = {}): Promise<WorkflowState> {
    this.logger.logWorkflowStart();
    this.logger.info('Starting daily workflow', options);

    const state: WorkflowState = {
      date: new Date().toISOString().split('T')[0],
      email_sent: false,
      status: 'idle',
      errors: [],
    };

    try {
      // Initialize database
      initDatabase();

      // Initialize modules
      const discovery = new DiscoveryModule(this.config.env.tavilyApiKey);
      const verification = new VerificationModule();
      const synthesis = new SynthesisModule(this.config.env.openaiApiKey);
      const visual = new VisualModule(this.config.env.openaiApiKey);
      const email = new EmailModule(this.config.env.resendApiKey);

      // Step 1: Check if email already sent today
      if (!options.forceRun && await email.emailSentToday()) {
        this.logger.info('✓ Email already sent today - skipping workflow');
        state.email_sent = true;
        state.status = 'completed';
        return state;
      }

      // Step 2: Check for verified unpublished artists
      let verifiedArtists = await artistOps.findVerifiedUnpublished();
      verifiedArtists = await this.filterArtistsWithSources(verifiedArtists, 1);
      this.logger.info(`Found ${verifiedArtists.length} verified unpublished artists with sources`);

      // Step 3: If no verified artists, run discovery loop until we find one
      if (verifiedArtists.length === 0 && !options.skipDiscovery) {
        this.logger.info('No verified artists - starting discovery loop');
        state.status = 'discovering';

        const maxAttempts = 10; // Maximum discovery rounds to prevent infinite loop
        let attempt = 0;

        // Keep discovering until we find at least one verified artist
        while (verifiedArtists.length === 0 && attempt < maxAttempts) {
          attempt++;
          this.logger.info(`Discovery attempt ${attempt}/${maxAttempts}`);

          // Discover 5 candidates per attempt
          const discoveryResult = await discovery.discover(5);
          this.logger.info(`Discovery round ${attempt}: ${discoveryResult.candidates.length} candidates found`, {
            errors: discoveryResult.errors,
          });

          if (discoveryResult.errors.length > 0) {
            state.errors.push(...discoveryResult.errors);
          }

          // Step 4: Verify discovered candidates
          if (discoveryResult.candidates.length > 0) {
            this.logger.info('Starting verification');
            state.status = 'verifying';

            const verificationResults = await verification.verifyAll();
            const verified = verificationResults.filter((r) => r.verified).length;
            this.logger.info(`Verification complete: ${verified}/${discoveryResult.candidates.length} verified`);

            // Re-fetch verified artists
            verifiedArtists = await artistOps.findVerifiedUnpublished();
            verifiedArtists = await this.filterArtistsWithSources(verifiedArtists, 1);

            // If we found at least one verified artist, stop discovery loop
            if (verifiedArtists.length > 0) {
              this.logger.info(`✓ Found ${verifiedArtists.length} verified artist(s) after ${attempt} attempt(s)`);
              break;
            }
          }

          // If no candidates found and no verified artists yet, continue searching
          if (verifiedArtists.length === 0 && attempt < maxAttempts) {
            this.logger.info(`No verified artists yet, continuing discovery (attempt ${attempt + 1}/${maxAttempts})...`);
          }
        }

        // Log if we hit max attempts
        if (attempt >= maxAttempts && verifiedArtists.length === 0) {
          this.logger.warn(`Reached maximum discovery attempts (${maxAttempts}) without finding verified artist`);
        }
      }

      // Step 5: Check if we have a verified artist to process
      if (verifiedArtists.length === 0) {
        this.logger.warn('No verified artists available - workflow stopping');
        state.status = 'completed';
        state.errors.push('No verified artists available');
        return state;
      }

      // Step 6: Select artist (prioritize by discovery date)
      const selectedArtist = verifiedArtists[0];
      state.artist_id = selectedArtist.id;
      this.logger.info(`Selected artist: ${selectedArtist.full_name} (ID: ${selectedArtist.id})`);

      // Step 6.5: Enrich sources with Scrapling (optional, non-fatal)
      try {
        const scraperBridge = new ScraperBridge();
        if (await scraperBridge.isAvailable()) {
          this.logger.info('Enriching sources with Scrapling');
          const sources = await sourceOps.findByArtistId(selectedArtist.id!);
          let enriched = 0;

          for (const source of sources) {
            // Only enrich sources with short or missing content summaries
            if (source.content_summary && source.content_summary.length >= 400) continue;

            try {
              const result = await scraperBridge.fetchPage(source.url);
              if (result.success && result.content && result.content.length > 100) {
                await sourceOps.updateContentSummary(source.id!, result.content);
                enriched++;
              }
            } catch (err) {
              this.logger.warn(`Failed to enrich source ${source.id}`, err);
            }
          }

          if (enriched > 0) {
            this.logger.info(`Enriched ${enriched}/${sources.length} sources`);
          }
        }
      } catch (error) {
        this.logger.warn('Source enrichment failed (non-fatal)', error);
      }

      // Step 7: Synthesize article
      this.logger.info('Starting article synthesis');
      state.status = 'synthesizing';

      const synthesisResult = await synthesis.synthesize(selectedArtist.id!);
      state.draft_id = synthesisResult.draft.id;
      this.logger.info('Article synthesized', synthesisResult.metadata);

      // Step 8: Source visual materials (with verified sources)
      this.logger.info('Sourcing verified images');
      const artistSources = await sourceOps.findByArtistId(selectedArtist.id!);
      const images = await visual.sourceImages(
        {
          full_name: selectedArtist.full_name,
          visual_practice: selectedArtist.visual_practice ?? undefined,
          birthplace_city: selectedArtist.birthplace_city ?? undefined,
          birthplace_state: selectedArtist.birthplace_state ?? undefined,
        },
        artistSources,
        synthesisResult.draft.id!,
        3
      );
      this.logger.info(`Sourced ${images.length} verified images`);

      // Zero images = warning, not fatal error (email supports no images)
      if (images.length === 0) {
        this.logger.warn('No verified images found — article will be sent without images');
      }

      // Step 9: Send approval email
      if (options.dryRun) {
        this.logger.info('DRY RUN - Skipping email send');
      } else {
        this.logger.info('Sending approval email');
        state.status = 'emailing';

        await email.sendApprovalEmail({
          draftId: synthesisResult.draft.id!,
          images,
        });

        state.email_sent = true;
        state.status = 'awaiting_approval';
        this.logger.info('✓ Approval email sent successfully');
      }

      state.status = 'completed';
      this.logger.logWorkflowEnd(true);

      return state;
    } catch (error) {
      this.logger.error('Workflow failed', error);
      state.status = 'error';
      state.errors.push(error instanceof Error ? error.message : String(error));
      this.logger.logWorkflowEnd(false);
      return state;
    } finally {
      closeDatabase();
    }
  }

  /**
   * Handle approval and publish
   */
  async handleApproval(draftId: number): Promise<void> {
    this.logger.info(`Processing approval for draft ${draftId}`);

    try {
      initDatabase();

      // Update draft status
      await draftOps.updateStatus(draftId, 'approved');
      this.logger.info('Draft marked as approved');

      // Check if Hashnode credentials are configured
      if (!this.config.env.hashnodeApiKey || !this.config.env.hashnodePublicationId) {
        this.logger.error('Hashnode API key or Publication ID not configured');
        throw new Error('Hashnode credentials not configured in environment');
      }

      // Publish
      const publishing = new PublishingModule(
        this.config.env.hashnodeApiKey,
        this.config.env.hashnodePublicationId
      );
      const result = await publishing.publish(draftId);

      if (result.success) {
        this.logger.info('✓ Article published successfully');
      } else {
        this.logger.error('Publishing failed', result.error);
      }
    } catch (error) {
      this.logger.error('Approval handling failed', error);
      throw error;
    } finally {
      closeDatabase();
    }
  }

  /**
   * Handle rejection: mark draft/artist as rejected, then re-run workflow for a new artist
   */
  async handleRejection(draftId: number): Promise<WorkflowState> {
    this.logger.info(`Processing rejection for draft ${draftId}`);

    try {
      initDatabase();

      const draft = await draftOps.findById(draftId);
      if (!draft) {
        throw new Error(`Draft ${draftId} not found`);
      }

      // Mark draft as rejected
      await draftOps.updateStatus(draftId, 'rejected');
      this.logger.info(`Draft ${draftId} marked as rejected`);

      // Mark artist as rejected so they won't be picked again
      await artistOps.updateStatus(draft.artist_id, 'rejected');
      this.logger.info(`Artist ${draft.artist_id} marked as rejected`);

      closeDatabase();
    } catch (error) {
      this.logger.error('Failed to mark rejection', error);
      closeDatabase();
      throw error;
    }

    // Re-run the full workflow to find a new artist
    this.logger.info('Re-running workflow to find a new artist');
    return this.execute({ forceRun: true });
  }

  private async filterArtistsWithSources(artists: Artist[], minSources: number): Promise<Artist[]> {
    if (artists.length === 0) return artists;

    const filtered: Artist[] = [];
    for (const artist of artists) {
      if (!artist.id) continue;
      try {
        const count = await sourceOps.countForArtist(artist.id);
        if (count >= minSources) {
          filtered.push(artist);
        } else {
          this.logger.warn(`Skipping artist ${artist.id} with ${count} sources (min ${minSources})`);
        }
      } catch (error) {
        this.logger.warn(`Failed to count sources for artist ${artist.id}`, error);
      }
    }

    return filtered;
  }
}
