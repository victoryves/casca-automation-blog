/**
 * Workflow Orchestrator
 *
 * Main workflow coordinator for daily execution.
 */

import { initDatabase, closeDatabase } from '../db/client.js';
import { artistOps, draftOps } from '../db/operations/index.js';
import { getConfig } from '../config/index.js';
import { DiscoveryModule } from '../modules/discovery/index.js';
import { VerificationModule } from '../modules/verification/index.js';
import { SynthesisModule } from '../modules/synthesis/index.js';
import { VisualModule } from '../modules/visual/index.js';
import { EmailModule } from '../modules/email/index.js';
import { PublishingModule } from '../modules/publishing/index.js';
import { Logger } from '../utils/logger.js';
import type { WorkflowState } from '../types/index.js';

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
      initDatabase({
        path: this.config.env.databasePath,
        verbose: this.config.env.logLevel === 'debug',
      });

      // Initialize modules
      const discovery = new DiscoveryModule(this.config.env.tavilyApiKey);
      const verification = new VerificationModule();
      const synthesis = new SynthesisModule(this.config.env.anthropicApiKey);
      const visual = new VisualModule();
      const email = new EmailModule(this.config.env.resendApiKey);

      // Step 1: Check if email already sent today
      if (!options.forceRun && email.emailSentToday()) {
        this.logger.info('✓ Email already sent today - skipping workflow');
        state.email_sent = true;
        state.status = 'completed';
        return state;
      }

      // Step 2: Check for verified unpublished artists
      let verifiedArtists = artistOps.findVerifiedUnpublished();
      this.logger.info(`Found ${verifiedArtists.length} verified unpublished artists`);

      // Step 3: If no verified artists, run discovery
      if (verifiedArtists.length === 0 && !options.skipDiscovery) {
        this.logger.info('No verified artists - starting discovery');
        state.status = 'discovering';

        const discoveryResult = await discovery.discover();
        this.logger.info(`Discovery complete: ${discoveryResult.candidates.length} candidates`, {
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
          this.logger.info(`Verification complete: ${verified} verified`);

          // Re-fetch verified artists
          verifiedArtists = artistOps.findVerifiedUnpublished();
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

      // Step 7: Synthesize article
      this.logger.info('Starting article synthesis');
      state.status = 'synthesizing';

      const synthesisResult = await synthesis.synthesize(selectedArtist.id!);
      state.draft_id = synthesisResult.draft.id;
      this.logger.info('Article synthesized', synthesisResult.metadata);

      // Step 8: Source visual materials
      this.logger.info('Sourcing images');
      const images = await visual.sourceImages(
        selectedArtist.full_name,
        synthesisResult.draft.id!,
        3
      );
      this.logger.info(`Sourced ${images.length} images`);

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
      initDatabase({
        path: this.config.env.databasePath,
      });

      // Update draft status
      draftOps.updateStatus(draftId, 'approved');
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
}
