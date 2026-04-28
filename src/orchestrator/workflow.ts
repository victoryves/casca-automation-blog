/**
 * Workflow Orchestrator
 *
 * Main workflow coordinator for daily execution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { initDatabase, closeDatabase } from '../db/local.js';
import { artistOps, draftOps, publishingOps, sourceOps } from '../db/operations/index.js';
import { getConfig, getInstitutionCredibility, getInstitutionName } from '../config/index.js';
import { DiscoveryModule } from '../modules/discovery/index.js';
import { VerificationModule } from '../modules/verification/index.js';
import { SynthesisModule } from '../modules/synthesis/index.js';
import { VisualModule } from '../modules/visual/index.js';
import { Dispatcher, EmailModule } from '../modules/email/index.js';
import { EmergencyFallbackModule } from '../modules/emergency/index.js';
import { PublishingModule } from '../modules/publishing/index.js';
import { PublicationHistoryModule } from '../modules/publication-history/index.js';
import { queueRejectedDraftReplacement } from '../modules/rejections/index.js';
import { ArtistResearchCache } from '../modules/research-cache/index.js';
import { ScraperBridge } from '../modules/scraper-bridge/index.js';
import { Logger } from '../utils/logger.js';
import type { WorkflowState, Artist, Image } from '../types/index.js';

export interface WorkflowOptions {
  dryRun?: boolean;
  skipDiscovery?: boolean;
  forceRun?: boolean;
  prepareOnly?: boolean;
  cacheOnly?: boolean;
}

interface PendingReplacementRequest {
  logId: number;
  draftId: number;
  requestedAt: string;
}

const MIN_APPROVAL_IMAGES = 3;
const MIN_APPROVAL_WORDS = 420;
const MAX_APPROVAL_PARAGRAPHS = 4;
const NORMAL_SEND_HOUR = 5;
const TARGET_READY_PENDING_DRAFTS = 50;
const TARGET_NEW_DRAFTS_PER_DAY = 5;
const DISCOVERY_BATCH_SIZE = 15;
const RESEARCH_CACHE_IMPORT_BATCH_SIZE = 50;
const IMAGE_SOURCING_TIMEOUT_MS = Number(process.env.IMAGE_SOURCING_TIMEOUT_MS ?? 4 * 60 * 1000);
const CACHE_SOURCE_TARGET = 6;
const CACHE_CANDIDATE_SOURCE_LIMIT = 5;
const VISUAL_READY_PREPASS_LIMIT = 3;
const ARTIST_FAILURE_COOLDOWN_HOURS = 6;
const ARTIST_HARD_FAILURE_THRESHOLD = 3;

interface ArtistWorkflowMetadata extends Record<string, unknown> {
  visual_ready_images?: Image[];
  visual_ready_at?: string;
  visual_ready_state?: 'ready' | 'pending' | 'failed';
  visual_ready_last_attempt_at?: string;
  visual_ready_last_image_count?: number;
  visual_ready_failure_count?: number;
  visual_ready_failure_reason?: string;
  visual_ready_blocked_until?: string;
  editorial_failure_count?: number;
  editorial_failure_reason?: string;
  editorial_failure_at?: string;
  editorial_blocked_until?: string;
  last_workflow_failure_at?: string;
  last_workflow_failure_date?: string;
  last_workflow_failure_reason?: string;
}

export class WorkflowOrchestrator {
  private logger: Logger;
  private config: ReturnType<typeof getConfig> | null;
  private publicationHistory: PublicationHistoryModule | null;

  constructor() {
    this.config = null;
    this.publicationHistory = null;
    this.logger = new Logger(
      './logs',
      ((process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info')
    );
  }

  /**
   * Execute daily workflow
   */
  async execute(options: WorkflowOptions = {}): Promise<WorkflowState> {
    const config = this.ensureConfig();
    this.logger.logWorkflowStart();
    this.logger.info('Starting daily workflow', options);

    const state: WorkflowState = {
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone:
          config.env.appTimezone ||
          Intl.DateTimeFormat().resolvedOptions().timeZone ||
          'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
      email_sent: false,
      prepared_draft: false,
      status: 'idle',
      errors: [],
    };

    try {
      // Initialize database
      initDatabase();

      // Initialize modules
      const discovery = new DiscoveryModule(config.env.exaApiKey);
      const verification = new VerificationModule();
      const synthesis = new SynthesisModule(config.env.geminiApiKey);
      const visual = new VisualModule(config.env.geminiApiKey);
      const email = new EmailModule(config.env.resendApiKey);
      const dispatcher = new Dispatcher(email);
      const emergencyFallback = new EmergencyFallbackModule();
      const pendingReplacementRequests = await this.getPendingReplacementRequests();
      const hasPendingReplacementRequest = pendingReplacementRequests.length > 0;
      const urgentReplacementSendRequested =
        hasPendingReplacementRequest && !options.prepareOnly;
      let sendWindowOpen = this.isNormalSendWindowOpen(config.env.appTimezone);
      if (options.forceRun) {
        this.logger.info('Force run enabled - allowing immediate send window');
        sendWindowOpen = true;
      }
      const blockedArtistNames = new Set<string>([
        ...(await this.getPreviouslySentArtistNames()),
        ...(await this.getOpenDraftArtistNames()),
      ]);
      let readyPendingDrafts = await this.loadUniqueReadyPendingDrafts(email);
      let readyPendingCount = readyPendingDrafts.length;
      let draftsCreatedToday = await draftOps.countCreatedOnDate(
        state.date,
        config.env.appTimezone
      );
      const computePreparationSlotsNeeded = (): number =>
        Math.max(
          Math.max(0, TARGET_READY_PENDING_DRAFTS - readyPendingCount),
          Math.max(0, TARGET_NEW_DRAFTS_PER_DAY - draftsCreatedToday)
        );
      let emailSentToday = await email.emailSentToday();
      let outstandingApprovalDraft = await this.resolveOutstandingApprovalDraft(email);
      let publishedToday = await publishingOps.publishedOnDate(
        state.date,
        config.env.appTimezone
      );
      let sendStillNeeded =
        sendWindowOpen && !publishedToday && !outstandingApprovalDraft;
      let preparationSlotsNeeded = computePreparationSlotsNeeded();

      if (options.prepareOnly) {
        this.logger.info(
          'Prepare-only mode enabled - skipping outbound email and focusing on backlog replenishment'
        );
        sendStillNeeded = false;
        state.status = 'discovering';
      }

      if (options.cacheOnly) {
        this.logger.info(
          'Cache-only mode enabled - only artists imported from the research cache will be used for new drafts'
        );
      }

      if (options.forceRun) {
        this.logger.info('Force run enabled - bypassing send/backlog guards for a fresh draft');
        emailSentToday = false;
        outstandingApprovalDraft = null;
        publishedToday = false;
        if (!options.prepareOnly) {
          sendStillNeeded = true;
        }
      }

      if (urgentReplacementSendRequested) {
        this.logger.info(
          `Pending replacement request detected (${pendingReplacementRequests.length}) - allowing immediate replacement send outside the normal daily window`
        );
        sendWindowOpen = true;
        emailSentToday = false;
        outstandingApprovalDraft = null;
        publishedToday = false;
        sendStillNeeded = true;
      }

      if (readyPendingDrafts.length > 0 && sendStillNeeded) {
        this.logger.info(
          `Dispatcher send window open with ${readyPendingDrafts.length} READY draft(s) available`
        );

        const dispatchResult = await dispatcher.sendNextAvailable(hasPendingReplacementRequest);
        if (dispatchResult.sent) {
          state.email_sent = true;
          state.artist_id = dispatchResult.artistId;
          state.draft_id = dispatchResult.draftId;
          state.status = 'awaiting_approval';
          emailSentToday = true;
          outstandingApprovalDraft = await this.resolveOutstandingApprovalDraft(email);
          sendStillNeeded = false;

          if (dispatchResult.artistName) {
            blockedArtistNames.add(this.normalizeArtistName(dispatchResult.artistName));
          }

          if (pendingReplacementRequests.length > 0) {
            const oldestPendingRequest = pendingReplacementRequests[0];
            await this.clearPendingReplacementRequest(oldestPendingRequest.logId);
            this.logger.info(
              `Cleared pending replacement request log ${oldestPendingRequest.logId}`
            );
          }
        } else {
          this.logger.warn(
            `Dispatcher found no sendable READY draft at send time: ${dispatchResult.reason ?? 'unknown reason'}`
          );
        }

        readyPendingDrafts = await this.loadUniqueReadyPendingDrafts(email);
        readyPendingCount = readyPendingDrafts.length;
      }

      if (hasPendingReplacementRequest && !urgentReplacementSendRequested) {
        this.logger.info(
          `Pending replacement request detected (${pendingReplacementRequests.length}) during prepare-only mode - queue will be replenished without sending`
        );
      }

      if (sendStillNeeded || preparationSlotsNeeded > 0) {
        const hydratablePendingDrafts = await draftOps.findHydratablePendingDrafts(MIN_APPROVAL_IMAGES);

        if (hydratablePendingDrafts.length > 0) {
          this.logger.info(
            `Attempting to hydrate ${hydratablePendingDrafts.length} pending draft(s) that still need images`
          );
        }

        for (const pendingDraft of hydratablePendingDrafts) {
          if (!sendStillNeeded && preparationSlotsNeeded <= 0) {
            break;
          }

          const pendingArtist = await artistOps.findById(pendingDraft.artist_id);
          if (!pendingArtist) {
            await draftOps.delete(pendingDraft.id!);
            this.logger.warn(
              `Discarded pending draft ${pendingDraft.id} because artist ${pendingDraft.artist_id} was missing`
            );
            continue;
          }

          if (!this.isDraftEditoriallyReady(pendingDraft, pendingArtist.full_name)) {
            await draftOps.delete(pendingDraft.id!);
            this.logger.warn(
              `Discarded pending draft ${pendingDraft.id} because the article was not editorially ready`
            );
            continue;
          }

          const normalizedPendingArtistName = this.normalizeArtistName(pendingArtist.full_name);
          const pendingArtistMetadata = artistOps.parseMetadata(pendingArtist);

          try {
            await this.enrichArtistSources(pendingArtist.id!);
            const artistSources = await sourceOps.findByArtistId(pendingArtist.id!);
            const images = await this.withTimeout(
              visual.sourceImages(
                {
                  full_name: pendingArtist.full_name,
                  visual_practice: pendingArtist.visual_practice ?? undefined,
                  birthplace_city: pendingArtist.birthplace_city ?? undefined,
                  birthplace_state: pendingArtist.birthplace_state ?? undefined,
                  artwork_candidates: Array.isArray(pendingArtistMetadata.research_cache_artwork_candidates)
                    ? pendingArtistMetadata.research_cache_artwork_candidates as Array<{
                        pageUrl: string;
                        imageUrl?: string;
                        title?: string;
                        sourceDomain?: string;
                        confidence?: number;
                      }>
                    : undefined,
                },
                artistSources,
                pendingDraft.id!,
                3
              ),
              IMAGE_SOURCING_TIMEOUT_MS,
              `Image sourcing timed out for pending draft ${pendingDraft.id}`
            );

            const curation = await visual.curateDraftImagesForReady(
              {
                full_name: pendingArtist.full_name,
                visual_practice: pendingArtist.visual_practice ?? undefined,
                birthplace_city: pendingArtist.birthplace_city ?? undefined,
                birthplace_state: pendingArtist.birthplace_state ?? undefined,
              },
              images
            );

            if (!curation.ready) {
              await draftOps.delete(pendingDraft.id!);
              this.logger.warn(
                `Discarded pending draft ${pendingDraft.id} because it still lacks enough approval-ready images (${curation.approved.length}/${MIN_APPROVAL_IMAGES})`
              );
              continue;
            }

            await draftOps.markCurated(pendingDraft.id!, curation.approved);
            await draftOps.markReady(
              pendingDraft.id!,
              curation.approved,
              sendStillNeeded || hasPendingReplacementRequest ? 100 : pendingDraft.priority ?? 0
            );
            blockedArtistNames.add(normalizedPendingArtistName);

            if (sendStillNeeded) {
              this.logger.info(`Dispatching hydrated READY draft ${pendingDraft.id}`);
              const dispatchResult = await dispatcher.sendNextAvailable(hasPendingReplacementRequest);
              if (!dispatchResult.sent) {
                throw new Error(
                  `Dispatcher could not send hydrated READY draft: ${dispatchResult.reason ?? 'unknown reason'}`
                );
              }

              state.email_sent = true;
              state.artist_id = dispatchResult.artistId ?? pendingDraft.artist_id;
              state.draft_id = dispatchResult.draftId ?? pendingDraft.id;
              state.status = 'awaiting_approval';
              sendStillNeeded = false;
              emailSentToday = true;

              if (pendingReplacementRequests.length > 0) {
                const oldestPendingRequest = pendingReplacementRequests[0];
                await this.clearPendingReplacementRequest(oldestPendingRequest.logId);
                this.logger.info(
                  `Cleared pending replacement request log ${oldestPendingRequest.logId}`
                );
              }
            } else {
              readyPendingCount++;
              state.prepared_draft = true;
              state.draft_id = state.draft_id ?? pendingDraft.id;
              preparationSlotsNeeded = computePreparationSlotsNeeded();
              this.logger.info(`Hydrated pending draft ${pendingDraft.id} for the ready backlog`);
            }
          } catch (pendingDraftError) {
            const message =
              pendingDraftError instanceof Error
                ? pendingDraftError.message
                : String(pendingDraftError);
            await draftOps.delete(pendingDraft.id!);
            this.logger.warn(
              `Discarded pending draft ${pendingDraft.id} after hydration failure: ${message}`
            );
          }
        }
      }

      if (options.skipDiscovery && state.email_sent) {
        state.prepared_draft = readyPendingCount > 0;
        state.draft_id = state.draft_id ?? readyPendingDrafts[0]?.id;
        state.status = 'awaiting_approval';
        return state;
      }

      if (
        !options.forceRun &&
        !hasPendingReplacementRequest &&
        emailSentToday &&
        readyPendingCount >= TARGET_READY_PENDING_DRAFTS &&
        draftsCreatedToday >= TARGET_NEW_DRAFTS_PER_DAY
      ) {
        this.logger.info(
          `✓ Email already sent today, backlog is healthy (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS}), and daily production is complete (${draftsCreatedToday}/${TARGET_NEW_DRAFTS_PER_DAY}) - skipping workflow`
        );
        state.email_sent = true;
        state.prepared_draft = readyPendingCount > 0;
        state.draft_id = readyPendingDrafts[0]?.id;
        state.status = 'completed';
        return state;
      }

      if (
        !options.forceRun &&
        !hasPendingReplacementRequest &&
        !sendWindowOpen &&
        readyPendingCount >= TARGET_READY_PENDING_DRAFTS &&
        draftsCreatedToday >= TARGET_NEW_DRAFTS_PER_DAY
      ) {
        this.logger.info(
          `✓ Backlog already prepared before the ${NORMAL_SEND_HOUR.toString().padStart(2, '0')}:00 send window (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS}) and daily production already reached (${draftsCreatedToday}/${TARGET_NEW_DRAFTS_PER_DAY})`
        );
        state.prepared_draft = true;
        state.draft_id = readyPendingDrafts[0]?.id;
        state.status = 'completed';
        return state;
      }

      const shouldPrepareOnly = !sendStillNeeded;

      if (shouldPrepareOnly && preparationSlotsNeeded > 0) {
        this.logger.info(
          options.prepareOnly
            ? `Prepare-only mode active, mining ${preparationSlotsNeeded} draft(s) to satisfy backlog (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS}) and daily production (${draftsCreatedToday}/${TARGET_NEW_DRAFTS_PER_DAY})`
            : emailSentToday
            ? `Email already sent today, preparing ${preparationSlotsNeeded} new draft(s) in the background to satisfy backlog (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS}) and daily production (${draftsCreatedToday}/${TARGET_NEW_DRAFTS_PER_DAY})`
            : `Before ${NORMAL_SEND_HOUR}:00 local time, preparing ${preparationSlotsNeeded} draft(s) without sending to satisfy backlog (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS}) and daily production (${draftsCreatedToday}/${TARGET_NEW_DRAFTS_PER_DAY})`
        );
      }

      if (!sendStillNeeded && preparationSlotsNeeded === 0) {
        state.prepared_draft = readyPendingCount > 0;
        state.draft_id = readyPendingDrafts[0]?.id;
        state.status = 'completed';
        return state;
      }

      const importedResearchArtistIds = await this.importResearchCacheArtists({
        limit: Math.max(RESEARCH_CACHE_IMPORT_BATCH_SIZE, preparationSlotsNeeded),
        blockedArtistNames,
      });

      if (importedResearchArtistIds.length > 0) {
        this.logger.info(
          `Imported ${importedResearchArtistIds.length} artist(s) from the pre-mined research cache for verification`
        );
        await verification.verifyBatch(importedResearchArtistIds);
      }

      // Step 2: Check for verified unpublished artists
      let verifiedArtists = await artistOps.findVerifiedUnpublished();
      if (options.cacheOnly) {
        verifiedArtists = verifiedArtists.filter((artist) => this.isResearchCacheImportedArtist(artist));
      }
      verifiedArtists = await this.filterArtistsWithSources(verifiedArtists, 1, blockedArtistNames);
      this.logger.info(`Found ${verifiedArtists.length} verified unpublished artists with sources`);

      if (verifiedArtists.length > 0 && (sendStillNeeded || preparationSlotsNeeded > 0)) {
        await this.prehydrateVisualReadyArtists(
          verifiedArtists,
          visual,
          Math.min(VISUAL_READY_PREPASS_LIMIT, Math.max(1, preparationSlotsNeeded || 1))
        );
      }

      const maxDiscoveryAttempts = 12;
      let discoveryAttempts = 0;
      let completed = false;
      const fallbackExcludedArtistIds = await this.getFallbackExcludedArtistIds(pendingReplacementRequests);

      while (sendStillNeeded || preparationSlotsNeeded > 0) {
        if (verifiedArtists.length === 0) {
          if (options.skipDiscovery || options.cacheOnly) {
            break;
          }

          this.logger.info('No verified artists available - starting discovery loop');
          state.status = 'discovering';

          while (verifiedArtists.length === 0 && discoveryAttempts < maxDiscoveryAttempts) {
            discoveryAttempts++;
            this.logger.info(`Discovery attempt ${discoveryAttempts}/${maxDiscoveryAttempts}`);

            const discoveryResult = await discovery.discover(DISCOVERY_BATCH_SIZE);
            this.logger.info(`Discovery round ${discoveryAttempts}: ${discoveryResult.candidates.length} candidates found`, {
              errors: discoveryResult.errors,
            });

            if (discoveryResult.errors.length > 0) {
              state.errors.push(...discoveryResult.errors);
            }

            if (discoveryResult.candidates.length > 0) {
              this.logger.info('Starting verification');
              state.status = 'verifying';

              const verificationResults = await verification.verifyBatch(
                discoveryResult.candidates
                  .map((candidate) => candidate.id)
                  .filter((id): id is number => typeof id === 'number')
              );
              const verified = verificationResults.filter((r) => r.verified).length;
              this.logger.info(`Verification complete: ${verified}/${discoveryResult.candidates.length} verified`);

              verifiedArtists = await artistOps.findVerifiedUnpublished();
              if (options.cacheOnly) {
                verifiedArtists = verifiedArtists.filter((artist) => this.isResearchCacheImportedArtist(artist));
              }
              verifiedArtists = await this.filterArtistsWithSources(verifiedArtists, 1, blockedArtistNames);

              if (verifiedArtists.length > 0) {
                this.logger.info(`✓ Found ${verifiedArtists.length} verified artist(s) after ${discoveryAttempts} attempt(s)`);
                break;
              }
            }

            if (verifiedArtists.length === 0 && discoveryAttempts < maxDiscoveryAttempts) {
              this.logger.info(
                `No verified artists yet, continuing discovery (attempt ${discoveryAttempts + 1}/${maxDiscoveryAttempts})...`
              );
            }
          }

          if (verifiedArtists.length === 0) {
            break;
          }
        }

        verifiedArtists = await this.rankArtistsForVariety(verifiedArtists);
        const selectedArtist = verifiedArtists.shift();
        if (!selectedArtist) {
          break;
        }

        const normalizedSelectedArtistName = this.normalizeArtistName(selectedArtist.full_name);
        if (blockedArtistNames.has(normalizedSelectedArtistName)) {
          this.logger.warn(
            `Skipping artist ${selectedArtist.id} (${selectedArtist.full_name}) because this artist is already blocked in the current workflow run`
          );
          continue;
        }

        state.artist_id = selectedArtist.id;
        this.logger.info(`Selected artist: ${selectedArtist.full_name} (ID: ${selectedArtist.id})`);
        let currentDraftId: number | undefined;
        const selectedArtistMetadata = artistOps.parseMetadata(selectedArtist);

        try {
          await this.enrichArtistSources(selectedArtist.id!);

          const enrichedSources = await sourceOps.findByArtistId(selectedArtist.id!);
          if (!this.hasEditorialSourceDepth(enrichedSources)) {
            await this.recordFailedArtistForDate(selectedArtist.full_name, state.date);
            await this.bumpArtistFailureMetadata(
              selectedArtist.id!,
              'editorial',
              'Artist lacks enough rich editorial sources after enrichment',
              state.date
            );
            this.logger.warn(
              `Skipping artist ${selectedArtist.id} because source enrichment still left insufficient editorial depth`
            );
            continue;
          }

          const visualReady = await this.ensureArtistVisualReady(
            selectedArtist,
            visual,
            selectedArtistMetadata
          );
          if (!visualReady.ready) {
            await this.recordFailedArtistForDate(selectedArtist.full_name, state.date);
            this.logger.warn(
              `Skipping artist ${selectedArtist.id} because visual-ready stage only found ${visualReady.images.length} approval-ready image(s)`
            );
            continue;
          }

          this.logger.info('Starting article synthesis');
          state.status = 'synthesizing';

          const synthesisResult = await synthesis.synthesize(selectedArtist.id!);
          currentDraftId = synthesisResult.draft.id;
          if (!state.email_sent) {
            state.draft_id = synthesisResult.draft.id;
          }
          this.logger.info('Article synthesized', synthesisResult.metadata);

          if (!this.isDraftEditoriallyReady(synthesisResult.draft, selectedArtist.full_name)) {
            await draftOps.delete(synthesisResult.draft.id!);
            await this.recordFailedArtistForDate(selectedArtist.full_name, state.date);
            await this.bumpArtistFailureMetadata(
              selectedArtist.id!,
              'editorial',
              'Draft did not meet editorial readiness requirements',
              state.date
            );
            state.draft_id = undefined;
            this.logger.warn(
              `Skipping artist ${selectedArtist.id} because the article did not meet editorial readiness requirements`
            );
            continue;
          }

          const curatedImages = await visual.curateDraftImagesForReady(
            {
              full_name: selectedArtist.full_name,
              visual_practice: selectedArtist.visual_practice ?? undefined,
              birthplace_city: selectedArtist.birthplace_city ?? undefined,
              birthplace_state: selectedArtist.birthplace_state ?? undefined,
            },
            visualReady.images
          );

          if (!curatedImages.ready) {
            await draftOps.delete(synthesisResult.draft.id!);
            await this.recordFailedArtistForDate(selectedArtist.full_name, state.date);
            await this.bumpArtistFailureMetadata(
              selectedArtist.id!,
              'visual',
              `Only ${curatedImages.approved.length} approval-ready image(s) were found`,
              state.date
            );
            state.draft_id = undefined;
            this.logger.warn(
              `Skipping artist ${selectedArtist.id} because only ${curatedImages.approved.length} approval-ready image(s) were found`
            );
            continue;
          }

          await draftOps.markCurated(synthesisResult.draft.id!, curatedImages.approved);
          await draftOps.markReady(
            synthesisResult.draft.id!,
            curatedImages.approved,
            sendStillNeeded || hasPendingReplacementRequest ? 100 : 0
          );

          if (options.dryRun) {
            this.logger.info('DRY RUN - Skipping email send');
            completed = true;
            sendStillNeeded = false;
            draftsCreatedToday++;
            preparationSlotsNeeded = computePreparationSlotsNeeded();
          } else if (sendStillNeeded) {
            this.logger.info('Sending approval email via dispatcher');
            state.status = 'emailing';
            const dispatchResult = await dispatcher.sendNextAvailable(hasPendingReplacementRequest);
            if (!dispatchResult.sent) {
              throw new Error(
                `Dispatcher could not send a READY draft after synthesis: ${dispatchResult.reason ?? 'unknown reason'}`
              );
            }

            state.email_sent = true;
            state.status = 'awaiting_approval';
            state.artist_id = dispatchResult.artistId ?? selectedArtist.id;
            state.draft_id = dispatchResult.draftId ?? synthesisResult.draft.id;
            this.logger.info('✓ Approval email sent successfully');

            sendStillNeeded = false;
            emailSentToday = true;
            draftsCreatedToday++;
            completed = true;
            blockedArtistNames.add(normalizedSelectedArtistName);

            if (pendingReplacementRequests.length > 0) {
              const oldestPendingRequest = pendingReplacementRequests[0];
              await this.clearPendingReplacementRequest(oldestPendingRequest.logId);
              this.logger.info(
                `Cleared pending replacement request log ${oldestPendingRequest.logId}`
              );
            }
          } else {
            state.prepared_draft = true;
            if (!state.email_sent) {
              state.draft_id = synthesisResult.draft.id;
            }
            this.logger.info(`✓ Draft ${synthesisResult.draft.id} prepared and saved for the next send window`);
            readyPendingCount++;
            draftsCreatedToday++;
            preparationSlotsNeeded = computePreparationSlotsNeeded();
            completed = true;
            blockedArtistNames.add(normalizedSelectedArtistName);
          }
        } catch (artistError) {
          if (currentDraftId) {
            try {
              await draftOps.delete(currentDraftId);
              if (state.draft_id === currentDraftId) {
                state.draft_id = undefined;
              }
            } catch (cleanupError) {
              this.logger.warn(`Failed to clean up draft ${currentDraftId}`, cleanupError);
            }
          }
          try {
            await this.recordFailedArtistForDate(selectedArtist.full_name, state.date);
            await this.bumpArtistFailureMetadata(
              selectedArtist.id!,
              'editorial',
              artistError instanceof Error ? artistError.message : String(artistError),
              state.date
            );
          } catch (statusError) {
            this.logger.warn(
              `Failed to persist failure metadata for artist ${selectedArtist.id} after workflow error`,
              statusError
            );
          }
          this.logger.warn(
            `Skipping artist ${selectedArtist.id} after workflow error`,
            artistError
          );
        }
      }

      while (sendStillNeeded || preparationSlotsNeeded > 0) {
        const fallbackDraft = await emergencyFallback.prepareFallbackDraft({
          minImages: MIN_APPROVAL_IMAGES,
          excludedArtistIds: fallbackExcludedArtistIds,
        });

        if (!fallbackDraft) {
          break;
        }

        fallbackExcludedArtistIds.add(fallbackDraft.artistId);
        this.logger.warn(
          `Using emergency fallback draft ${fallbackDraft.draftId} cloned from ${fallbackDraft.sourceDraftId} for ${fallbackDraft.artistName}`
        );

        if (!state.email_sent) {
          state.artist_id = fallbackDraft.artistId;
          state.draft_id = fallbackDraft.draftId;
        }

        if (options.dryRun) {
          completed = true;
          if (sendStillNeeded) {
            sendStillNeeded = false;
          } else if (preparationSlotsNeeded > 0) {
            state.prepared_draft = true;
            readyPendingCount++;
            draftsCreatedToday++;
            preparationSlotsNeeded = computePreparationSlotsNeeded();
          }
          continue;
        }

        if (sendStillNeeded) {
          try {
            await draftOps.markCurated(fallbackDraft.draftId, fallbackDraft.images);
            await draftOps.markReady(
              fallbackDraft.draftId,
              fallbackDraft.images,
              hasPendingReplacementRequest ? 100 : 0
            );
            const dispatchResult = await dispatcher.sendNextAvailable(hasPendingReplacementRequest);
            if (!dispatchResult.sent) {
              throw new Error(
                `Dispatcher could not send emergency fallback draft: ${dispatchResult.reason ?? 'unknown reason'}`
              );
            }

            state.email_sent = true;
            state.status = 'awaiting_approval';
            state.artist_id = dispatchResult.artistId ?? fallbackDraft.artistId;
            state.draft_id = dispatchResult.draftId ?? fallbackDraft.draftId;
            sendStillNeeded = false;
            emailSentToday = true;
            completed = true;

            if (pendingReplacementRequests.length > 0) {
              const oldestPendingRequest = pendingReplacementRequests[0];
              await this.clearPendingReplacementRequest(oldestPendingRequest.logId);
              this.logger.info(
                `Cleared pending replacement request log ${oldestPendingRequest.logId}`
              );
            }
          } catch (fallbackError) {
            const message =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            this.logger.warn(
              `Emergency fallback draft ${fallbackDraft.draftId} failed to send: ${message}`
            );
            fallbackExcludedArtistIds.add(fallbackDraft.artistId);
            await draftOps.delete(fallbackDraft.draftId);
            continue;
          }
        } else {
          await draftOps.markCurated(fallbackDraft.draftId, fallbackDraft.images);
          await draftOps.markReady(fallbackDraft.draftId, fallbackDraft.images);
          state.prepared_draft = true;
          readyPendingCount++;
          draftsCreatedToday++;
          preparationSlotsNeeded = computePreparationSlotsNeeded();
          completed = true;
        }
      }

      if (!completed || sendStillNeeded || preparationSlotsNeeded > 0) {
        throw new Error(`No verified artist produced an approval-ready article with at least ${MIN_APPROVAL_IMAGES} pure artworks`);
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
  async handleApproval(draftId: number, featuredImageIndex = 0): Promise<void> {
    this.logger.info(`Processing approval for draft ${draftId} with featured image ${featuredImageIndex}`);

    try {
      initDatabase();

      // Update draft status
      await draftOps.updateStatus(draftId, 'approved');
      this.logger.info('Draft marked as approved');

      const hashnodeApiKey = process.env.HASHNODE_API_KEY;
      const hashnodePublicationId = process.env.HASHNODE_PUBLICATION_ID;

      // Check if Hashnode credentials are configured
      if (!hashnodeApiKey || !hashnodePublicationId) {
        this.logger.error('Hashnode API key or Publication ID not configured');
        throw new Error('Hashnode credentials not configured in environment');
      }

      // Publish
      const publishing = new PublishingModule(
        hashnodeApiKey,
        hashnodePublicationId
      );
      const result = await publishing.publish(draftId, featuredImageIndex);

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
  async handleRejection(draftId: number): Promise<{ queued: boolean; alreadyRejected: boolean }> {
    this.logger.info(`Processing rejection for draft ${draftId}`);

    try {
      initDatabase();
      const result = await queueRejectedDraftReplacement(draftId);
      this.logger.info(`Queued replacement request for rejected draft ${draftId}`);
      return result;
    } catch (error) {
      this.logger.error('Failed to mark rejection', error);
      throw error;
    } finally {
      closeDatabase();
    }
  }

  private async importResearchCacheArtists(params: {
    limit: number;
    blockedArtistNames: Set<string>;
  }): Promise<number[]> {
    const { limit, blockedArtistNames } = params;
    if (limit <= 0) {
      return [];
    }

    const researchCache = new ArtistResearchCache();
    const entries = await researchCache.readAll();
    if (entries.length === 0) {
      return [];
    }

    const previouslySentNames = await this.getPreviouslySentArtistNames();
    const openDraftNames = await this.getOpenDraftArtistNames();
    const blockedNameList = [
      ...blockedArtistNames,
      ...previouslySentNames,
      ...openDraftNames,
    ];
    const externallyPublishedHaystacks = await this.getPublishedBlogHaystacks();
    const importedArtistIds = new Set<number>();

    const orderedEntries = [...entries].sort((a, b) => {
      const premiumA = this.getResearchCacheEntryConversionScore(a);
      const premiumB = this.getResearchCacheEntryConversionScore(b);
      if (premiumA !== premiumB) {
        return premiumB - premiumA;
      }

      const rankA = a.shortlistRank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.shortlistRank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) {
        return rankA - rankB;
      }

      return (a.minedAt ?? '').localeCompare(b.minedAt ?? '');
    });

    for (const entry of orderedEntries) {
      if (importedArtistIds.size >= limit) {
        break;
      }

      const normalizedArtistName = this.normalizeArtistName(entry.artistName);
      if (!normalizedArtistName) {
        continue;
      }

      if (!entry.repetition?.eligible) {
        continue;
      }

      if (entry.biographySources.length < 2 || entry.artworkCandidates.length < MIN_APPROVAL_IMAGES) {
        continue;
      }

      if (this.isPotentialDuplicateName(normalizedArtistName, blockedNameList)) {
        continue;
      }

      if (this.isArtistPublishedInExternalBlog(entry.artistName, externallyPublishedHaystacks)) {
        continue;
      }

      const existingArtist = await artistOps.findByNormalizedName(entry.artistName);
      if (existingArtist?.status === 'published' || existingArtist?.status === 'rejected') {
        continue;
      }

      const artistId =
        existingArtist?.id ??
        (await artistOps.create({
          full_name: entry.artistName,
          birthplace_city: undefined,
          birthplace_state: entry.states,
          visual_practice: entry.practice,
          status: 'discovered',
          metadata: JSON.stringify({
            curated: true,
            shortlist_rank: entry.shortlistRank ?? null,
            research_cache_imported_at: new Date().toISOString(),
            research_cache_mined_at: entry.minedAt,
            research_cache_category: entry.category ?? null,
            research_cache_notes: entry.notes,
            research_cache_artwork_candidates: entry.artworkCandidates.slice(0, 5),
          }),
        }));

      if (!artistId) {
        continue;
      }

      if (existingArtist?.id) {
        await artistOps.mergeMetadata(artistId, {
          shortlist_rank: entry.shortlistRank ?? null,
          research_cache_imported_at: new Date().toISOString(),
          research_cache_mined_at: entry.minedAt,
          research_cache_category: entry.category ?? null,
          research_cache_notes: entry.notes,
          research_cache_artwork_candidates: entry.artworkCandidates.slice(0, 5),
        });
      }

      for (const biographySource of entry.biographySources) {
        if (await sourceOps.exists(artistId, biographySource.url)) {
          continue;
        }

        await sourceOps.create({
          artist_id: artistId,
          url: biographySource.url,
          institution: biographySource.institution,
          credibility_score: biographySource.credibilityScore,
          content_summary: biographySource.summary,
        });
      }

      await this.attachResearchCacheCandidateSources(artistId, entry.artistName, entry.artworkCandidates);

      const sources = await sourceOps.findByArtistId(artistId);
      const eligibleSourceCount = sources.filter(
        (source) => !this.isSocialSource(source.url, source.institution)
      ).length;

      if (eligibleSourceCount < 2) {
        continue;
      }

      blockedNameList.push(normalizedArtistName);
      importedArtistIds.add(artistId);
    }

    return Array.from(importedArtistIds);
  }

  private async filterArtistsWithSources(
    artists: Artist[],
    minSources: number,
    blockedArtistNames: Set<string> = new Set<string>()
  ): Promise<Artist[]> {
    if (artists.length === 0) return artists;

    const excludedArtistNames = await this.getPreviouslySentArtistNames();
    const openDraftArtistNames = await this.getOpenDraftArtistNames();
    const blockedNameList = [
      ...blockedArtistNames,
      ...excludedArtistNames,
      ...openDraftArtistNames,
    ];
    const externallyPublishedHaystacks = await this.getPublishedBlogHaystacks();
    const filtered: Artist[] = [];
    const cooledDownFallbackCandidates: Artist[] = [];

    for (const artist of artists) {
      if (!artist.id) continue;
      try {
        const normalizedArtistName = this.normalizeArtistName(artist.full_name);
        if (this.isPotentialDuplicateName(normalizedArtistName, blockedNameList)) {
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because a near-duplicate name was already used`
          );
          continue;
        }
        if (blockedArtistNames.has(normalizedArtistName)) {
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because this artist is blocked in the current workflow run`
          );
          continue;
        }

        if (this.isArtistCoolingDown(artist)) {
          cooledDownFallbackCandidates.push(artist);
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because this artist is cooling down after repeated failures`
          );
          continue;
        }

        if (excludedArtistNames.has(normalizedArtistName)) {
          this.logger.warn(`Skipping artist ${artist.id} (${artist.full_name}) because this artist was already emailed before`);
          continue;
        }

        if (openDraftArtistNames.has(normalizedArtistName)) {
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because this artist already has an open draft by name`
          );
          continue;
        }

        if (this.isArtistPublishedInExternalBlog(artist.full_name, externallyPublishedHaystacks)) {
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because this artist already appears in the published blog history`
          );
          continue;
        }

        const drafts = await draftOps.findByArtistId(artist.id);
        const hasOpenDraft = drafts.some((draft) =>
          ['pending', 'researched', 'curated', 'drafted', 'ready', 'sent'].includes(draft.status)
        );
        if (hasOpenDraft) {
          this.logger.warn(`Skipping artist ${artist.id} because there is already an open draft awaiting use or approval`);
          continue;
        }

        const sources = await sourceOps.findByArtistId(artist.id);
        const eligibleSourceCount = sources.filter(
          (source) => !this.isSocialSource(source.url, source.institution)
        ).length;

        if (eligibleSourceCount >= minSources) {
          filtered.push(artist);
        } else {
          this.logger.warn(
            `Skipping artist ${artist.id} with ${eligibleSourceCount} eligible non-social sources (min ${minSources})`
          );
        }
      } catch (error) {
        this.logger.warn(`Failed to count sources for artist ${artist.id}`, error);
      }
    }

    if (filtered.length === 0 && cooledDownFallbackCandidates.length > 0) {
      const rankedFallback = await this.rankArtistsForVariety(cooledDownFallbackCandidates);
      const reintroduced = rankedFallback.slice(0, Math.min(5, rankedFallback.length));
      this.logger.warn(
        `No non-cooled verified artists were available; reintroducing ${reintroduced.length} cooled-down fallback artist(s)`
      );
      return reintroduced;
    }

    return filtered;
  }

  private async rankArtistsForVariety(artists: Artist[]): Promise<Artist[]> {
    if (artists.length <= 1) {
      return artists;
    }

    const recentSentDrafts = await draftOps.findByStatus('sent');
    const recentPracticeCounts = new Map<string, number>();
    const recentArtistIds = new Set<number>();
    const sourceQualityScores = new Map<number, number>();

    for (const draft of recentSentDrafts.slice(0, 12)) {
      recentArtistIds.add(draft.artist_id);
      const artist = await artistOps.findById(draft.artist_id);
      const practice = this.normalizePractice(artist?.visual_practice);
      recentPracticeCounts.set(practice, (recentPracticeCounts.get(practice) ?? 0) + 1);
    }

    for (const artist of artists) {
      if (!artist.id) continue;
      try {
        const sources = await sourceOps.findByArtistId(artist.id);
        sourceQualityScores.set(artist.id, this.getSourceQualityScore(sources.map((source) => source.url)));
      } catch {
        sourceQualityScores.set(artist.id, 0);
      }
    }

    return [...artists].sort((a, b) => {
      const scoreA = this.getBacklogReadinessScore(a);
      const scoreB = this.getBacklogReadinessScore(b);
      if (scoreA !== scoreB) return scoreB - scoreA;

      const sourceScoreA = sourceQualityScores.get(a.id ?? -1) ?? 0;
      const sourceScoreB = sourceQualityScores.get(b.id ?? -1) ?? 0;
      if (sourceScoreA !== sourceScoreB) return sourceScoreB - sourceScoreA;

      const practiceA = this.normalizePractice(a.visual_practice);
      const practiceB = this.normalizePractice(b.visual_practice);
      const countA = recentPracticeCounts.get(practiceA) ?? 0;
      const countB = recentPracticeCounts.get(practiceB) ?? 0;

      if (countA !== countB) return countA - countB;

      const seenA = recentArtistIds.has(a.id ?? -1) ? 1 : 0;
      const seenB = recentArtistIds.has(b.id ?? -1) ? 1 : 0;
      if (seenA !== seenB) return seenA - seenB;

      return 0;
    });
  }

  private normalizePractice(practice?: string | null): string {
    if (!practice) return 'unknown';

    const normalized = practice
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (normalized.includes('xilo') || normalized.includes('woodcut')) return 'xilogravura';
    if (normalized.includes('pint')) return 'pintura';
    if (normalized.includes('fot')) return 'fotografia';
    if (normalized.includes('escult')) return 'escultura';
    if (normalized.includes('instal')) return 'instalacao';
    if (normalized.includes('desenh') || normalized.includes('drawing')) return 'desenho';
    if (normalized.includes('ceram')) return 'ceramica';
    if (normalized.includes('gravur') || normalized.includes('print')) return 'gravura';
    if (normalized.includes('performance')) return 'performance';
    if (normalized.includes('conceit')) return 'arte_conceitual';
    if (normalized.includes('ilustr')) return 'ilustracao';
    if (normalized.includes('quadrinh') || normalized.includes('comic')) return 'quadrinhos';
    if (normalized.includes('design')) return 'design';
    if (normalized.includes('graffiti')) return 'graffiti';
    if (normalized.includes('mural')) return 'muralismo';
    if (normalized.includes('urban')) return 'arte_urbana';

    return normalized;
  }

  private getBacklogReadinessScore(artist: Artist): number {
    const metadata = artistOps.parseMetadata(artist) as ArtistWorkflowMetadata;
    const cachedCandidates = Array.isArray(metadata.research_cache_artwork_candidates)
      ? (metadata.research_cache_artwork_candidates as Array<{
          pageUrl?: string;
          sourceDomain?: string;
          confidence?: number;
        }>)
      : [];
    const shortlistRank =
      typeof metadata.shortlist_rank === 'number' ? metadata.shortlist_rank : null;

    let score = this.getPracticeConversionScore(artist.visual_practice);

    if (this.getVisualReadyImagesFromMetadata(metadata).length >= MIN_APPROVAL_IMAGES) {
      score += 40;
    }
    if (metadata.visual_ready_state === 'ready') {
      score += 10;
    } else if (metadata.visual_ready_state === 'failed') {
      score -= 10;
    }

    if (cachedCandidates.length >= 3) score += 4;
    if (cachedCandidates.length >= 5) score += 3;
    if (cachedCandidates.some((candidate) => this.isPremiumArtworkCandidate(candidate))) {
      score += 4;
    }
    if (cachedCandidates.filter((candidate) => this.isPremiumArtworkCandidate(candidate)).length >= 2) {
      score += 3;
    }
    if (typeof shortlistRank === 'number') {
      score += Math.max(0, 4 - Math.floor(shortlistRank / 40));
    }

    const visualFailures = Number(metadata.visual_ready_failure_count ?? 0) || 0;
    const editorialFailures = Number(metadata.editorial_failure_count ?? 0) || 0;
    score -= Math.min(18, visualFailures * 4 + editorialFailures * 3);

    return score;
  }

  private getSourceQualityScore(urls: string[]): number {
    let score = 0;

    for (const url of urls) {
      const normalized = url.toLowerCase();

      if (/escritoriodearte\.com\/artista\/[^/]+\/[^/]+/.test(normalized)) {
        score += 5;
        continue;
      }

      if (normalized.includes('escritoriodearte.com/artista/')) {
        score += 3;
        continue;
      }

      if (
        normalized.includes('itaucultural') ||
        normalized.includes('pinacoteca') ||
        normalized.includes('museu') ||
        normalized.includes('instituto') ||
        normalized.includes('inhotim')
      ) {
        score += 3;
        continue;
      }

      if (normalized.includes('dailyartfair.com/artist/')) {
        score += 1;
        continue;
      }
    }

    return score;
  }

  private getResearchCacheEntryConversionScore(entry: {
    practice?: string;
    category?: string;
    shortlistRank?: number;
    biographySources: Array<{ url: string; credibilityScore?: number }>;
    artworkCandidates: Array<{
      pageUrl?: string;
      sourceDomain?: string;
      confidence?: number;
      title?: string;
    }>;
  }): number {
    let score = this.getPracticeConversionScore(entry.practice);

    score += Math.min(4, entry.biographySources.length);
    score += Math.min(6, entry.artworkCandidates.length * 2);

    const premiumArtworkCandidates = entry.artworkCandidates.filter((candidate) =>
      this.isPremiumArtworkCandidate(candidate)
    );
    score += premiumArtworkCandidates.length * 3;

    const strongConfidenceCount = entry.artworkCandidates.filter(
      (candidate) => (candidate.confidence ?? 0) >= 0.82
    ).length;
    score += Math.min(4, strongConfidenceCount);

    const category = this.normalizeText(entry.category ?? '');
    if (
      category.includes('pintura') ||
      category.includes('armorial') ||
      category.includes('xilogravura') ||
      category.includes('arte popular') ||
      category.includes('naif')
    ) {
      score += 4;
    } else if (category.includes('fotografia') || category.includes('arte contemporanea')) {
      score += 1;
    }

    if (typeof entry.shortlistRank === 'number') {
      score += Math.max(0, 5 - Math.floor(entry.shortlistRank / 30));
    }

    return score;
  }

  private getPracticeConversionScore(practice?: string | null): number {
    const normalized = this.normalizePractice(practice);

    switch (normalized) {
      case 'pintura':
      case 'escultura':
      case 'xilogravura':
      case 'gravura':
      case 'ceramica':
      case 'desenho':
        return 10;
      case 'ilustracao':
      case 'quadrinhos':
      case 'design':
        return 7;
      case 'fotografia':
        return 5;
      case 'performance':
      case 'instalacao':
      case 'arte_conceitual':
      case 'arte_urbana':
      case 'graffiti':
      case 'muralismo':
        return 1;
      default:
        return 4;
    }
  }

  private isPremiumArtworkCandidate(candidate: {
    pageUrl?: string;
    sourceDomain?: string;
    confidence?: number;
    title?: string;
  }): boolean {
    const pageUrl = (candidate.pageUrl ?? '').toLowerCase();
    const sourceDomain = (candidate.sourceDomain ?? '').toLowerCase();
    const title = this.normalizeText(candidate.title ?? '');
    const haystack = `${pageUrl} ${sourceDomain}`;
    const confidence = candidate.confidence ?? 0;

    if (confidence < 0.72) {
      return false;
    }

    if (
      haystack.includes('artsandculture.google.com') ||
      haystack.includes('itaucultural') ||
      haystack.includes('pinacoteca') ||
      haystack.includes('museu') ||
      haystack.includes('instituto') ||
      haystack.includes('escritoriodearte') ||
      haystack.includes('enciclopedia.itaucultural')
    ) {
      return true;
    }

    if (confidence >= 0.85 && title && !title.includes('artist') && !title.includes('portrait')) {
      return true;
    }

    return false;
  }

  private async enrichArtistSources(artistId: number): Promise<void> {
    try {
      const scraperBridge = new ScraperBridge();
      if (!(await scraperBridge.isPageFetchAvailable())) {
        return;
      }

      const artist = await artistOps.findById(artistId);
      if (!artist) {
        return;
      }

      const metadata = artistOps.parseMetadata(artist);
      if (Array.isArray(metadata.research_cache_artwork_candidates)) {
        await this.attachResearchCacheCandidateSources(
          artistId,
          artist.full_name,
          metadata.research_cache_artwork_candidates as Array<{
            pageUrl: string;
            imageUrl?: string;
            title?: string;
            sourceDomain?: string;
            confidence?: number;
          }>
        );
      }

      this.logger.info('Enriching sources with multi-backend scraping');
      let sources = await sourceOps.findByArtistId(artistId);
      let enriched = 0;
      let createdSources = 0;

      const prioritizedSources = [...sources].sort((a, b) => {
        const summaryReadyA = (a.content_summary?.length ?? 0) >= 700 ? 1 : 0;
        const summaryReadyB = (b.content_summary?.length ?? 0) >= 700 ? 1 : 0;

        if (summaryReadyA !== summaryReadyB) {
          return summaryReadyA - summaryReadyB;
        }

        return (b.credibility_score ?? 0) - (a.credibility_score ?? 0);
      });

      for (const source of prioritizedSources.slice(0, 10)) {
        if (source.content_summary && source.content_summary.length >= 700) continue;

        try {
          const result = await scraperBridge.fetchPage(source.url);
          if (result.success && result.content && result.content.length > 100) {
            await sourceOps.updateContentSummary(source.id!, result.content);
            enriched++;
            createdSources += await this.persistDiscoveredSourceLinks(
              artistId,
              source.url,
              result.discovered_urls ?? []
            );
          }
        } catch (err) {
          this.logger.warn(`Failed to enrich source ${source.id}`, err);
        }
      }

      if (createdSources > 0) {
        sources = await sourceOps.findByArtistId(artistId);
      }

      const eligibleSourceCount = sources.filter(
        (source) => !this.isSocialSource(source.url, source.institution)
      ).length;

      if (eligibleSourceCount < CACHE_SOURCE_TARGET) {
        const refreshedArtist = await artistOps.findById(artistId);
        const refreshedMetadata = artistOps.parseMetadata(refreshedArtist);

        if (Array.isArray(refreshedMetadata.research_cache_artwork_candidates)) {
          createdSources += await this.attachResearchCacheCandidateSources(
            artistId,
            refreshedArtist?.full_name ?? artist.full_name,
            refreshedMetadata.research_cache_artwork_candidates as Array<{
              pageUrl: string;
              imageUrl?: string;
              title?: string;
              sourceDomain?: string;
              confidence?: number;
            }>
          );
        }
      }

      if (enriched > 0) {
        this.logger.info(`Enriched ${enriched}/${sources.length} sources`);
      }

      if (createdSources > 0) {
        this.logger.info(`Added ${createdSources} extra source(s) from research-cache candidates`);
      }
    } catch (error) {
      this.logger.warn('Source enrichment failed (non-fatal)', error);
    }
  }

  private async persistDiscoveredSourceLinks(
    artistId: number,
    parentUrl: string,
    discoveredUrls: string[]
  ): Promise<number> {
    if (discoveredUrls.length === 0) {
      return 0;
    }

    const artist = await artistOps.findById(artistId);
    if (!artist) {
      return 0;
    }

    const existingSources = await sourceOps.findByArtistId(artistId);
    const existingUrls = new Set(existingSources.map((source) => source.url));
    const config = this.ensureConfig();
    let created = 0;

    for (const candidateUrl of discoveredUrls) {
      if (created >= 3) {
        break;
      }

      if (!this.shouldPersistDiscoveredSource(candidateUrl, parentUrl, artist.full_name)) {
        continue;
      }

      if (existingUrls.has(candidateUrl)) {
        continue;
      }

      const institution = getInstitutionName(candidateUrl, config.institutions) || 'Discovered Source';
      const credibility = getInstitutionCredibility(candidateUrl, config.institutions) || 0.72;

      try {
        await sourceOps.create({
          artist_id: artistId,
          url: candidateUrl,
          institution,
          credibility_score: Math.max(0.65, credibility),
          content_summary: '',
        });
        existingUrls.add(candidateUrl);
        created++;
      } catch {
        // Unique constraint or transient failure: safe to ignore.
      }
    }

    return created;
  }

  private async attachResearchCacheCandidateSources(
    artistId: number,
    artistName: string,
    artworkCandidates: Array<{
      pageUrl: string;
      imageUrl?: string;
      title?: string;
      sourceDomain?: string;
      confidence?: number;
    }>
  ): Promise<number> {
    if (!Array.isArray(artworkCandidates) || artworkCandidates.length === 0) {
      return 0;
    }

    const existingSources = await sourceOps.findByArtistId(artistId);
    const existingUrls = new Set(existingSources.map((source) => source.url));
    const config = this.ensureConfig();
    let created = 0;

    const sortedCandidates = [...artworkCandidates]
      .filter((candidate) => candidate?.pageUrl)
      .filter((candidate) => this.isStrongResearchCacheCandidate(candidate, artistName))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, CACHE_CANDIDATE_SOURCE_LIMIT);

    for (const candidate of sortedCandidates) {
      const candidateUrl = candidate.pageUrl;
      if (!candidateUrl || existingUrls.has(candidateUrl)) {
        continue;
      }

      if (this.isSocialLikeUrl(candidateUrl)) {
        continue;
      }

      const institution =
        getInstitutionName(candidateUrl, config.institutions) ||
        candidate.sourceDomain ||
        'Artwork Source';
      const credibility =
        getInstitutionCredibility(candidateUrl, config.institutions) ||
        Math.max(0.68, Math.min(0.9, candidate.confidence ?? 0.72));

      try {
        await sourceOps.create({
          artist_id: artistId,
          url: candidateUrl,
          institution,
          credibility_score: credibility,
          content_summary: candidate.title ?? '',
        });
        existingUrls.add(candidateUrl);
        created++;
      } catch {
        // Ignore duplicates and transient insert issues.
      }
    }

    return created;
  }

  private isStrongResearchCacheCandidate(candidate: {
    pageUrl: string;
    imageUrl?: string;
    title?: string;
    sourceDomain?: string;
    confidence?: number;
  }, artistName: string): boolean {
    const normalizedPage = this.normalizeArtistName(candidate.pageUrl ?? '');
    const normalizedTitle = this.normalizeArtistName(candidate.title ?? '');
    const normalizedImage = this.normalizeArtistName(candidate.imageUrl ?? '');
    const confidence = candidate.confidence ?? 0;

    if (!candidate.pageUrl) {
      return false;
    }

    if (this.isSocialLikeUrl(candidate.pageUrl)) {
      return false;
    }

    if (!this.researchCandidateTargetsArtist(candidate, artistName)) {
      return false;
    }

    const blockedSignals = [
      'principais obras',
      'principais tags',
      'imagens',
      'artista',
      'artista visual',
      'profile',
      'perfil',
      'galeria',
      'gallery',
      'leilao',
      'leiloeiro',
      'auction',
    ];

    if (blockedSignals.some((signal) => normalizedTitle.includes(signal) || normalizedPage.includes(signal))) {
      return false;
    }

    const isEscritorioArtworkPage =
      normalizedPage.includes('escritoriodearte com artista') &&
      /-\d+$/.test(candidate.pageUrl.split('/').filter(Boolean).pop() ?? '');
    const isHighResArtworkAsset =
      normalizedImage.includes('escritoriodearte com quadro') &&
      (normalizedImage.includes(' g jpg') ||
        normalizedImage.includes(' g jpeg') ||
        normalizedImage.includes(' g png') ||
        normalizedImage.includes(' g webp'));

    if (isEscritorioArtworkPage || isHighResArtworkAsset) {
      return true;
    }

    return confidence >= 0.78;
  }

  private researchCandidateTargetsArtist(
    candidate: {
      pageUrl: string;
      imageUrl?: string;
      title?: string;
      sourceDomain?: string;
      confidence?: number;
    },
    artistName: string
  ): boolean {
    const normalizedArtist = this.normalizeArtistName(artistName);
    if (!normalizedArtist) {
      return false;
    }

    const haystack = this.normalizeArtistName(
      `${candidate.pageUrl ?? ''} ${candidate.imageUrl ?? ''} ${candidate.title ?? ''}`
    );
    const tokens = normalizedArtist.split(' ').filter(Boolean);

    if (tokens.length === 1) {
      const token = tokens[0];
      if (token.length < 6) {
        return false;
      }

      return haystack.includes(token);
    }

    if (haystack.includes(normalizedArtist)) {
      return true;
    }

    const surname = tokens[tokens.length - 1];
    const distinctiveGiven = tokens.slice(0, -1).filter((token) => token.length >= 4);
    if (!haystack.includes(surname)) {
      return false;
    }

    return distinctiveGiven.length === 0 || distinctiveGiven.some((token) => haystack.includes(token));
  }

  private async getPendingReplacementRequests(): Promise<PendingReplacementRequest[]> {
    const failedLogs = await publishingOps.findFailed();

    return failedLogs
      .filter((log) => log.id && log.draft_id && log.error_message === 'replacement_requested')
      .map((log) => ({
        logId: log.id!,
        draftId: log.draft_id,
        requestedAt: log.published_at ?? '',
      }))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  private async clearPendingReplacementRequest(logId: number): Promise<void> {
    await publishingOps.delete(logId);
  }

  private async getPreviouslySentArtistNames(): Promise<Set<string>> {
    const drafts = await draftOps.findByStatus('sent');
    const approvedDrafts = await draftOps.findByStatus('approved');
    const rejectedDrafts = await draftOps.findByStatus('rejected');
    const seenNames = new Set<string>();

    for (const draft of [...drafts, ...approvedDrafts, ...rejectedDrafts]) {
      const artist = await artistOps.findById(draft.artist_id);
      if (!artist?.full_name) {
        continue;
      }

      seenNames.add(this.normalizeArtistName(artist.full_name));
    }

    return seenNames;
  }

  private async getOpenDraftArtistNames(): Promise<Set<string>> {
    const pendingDrafts = [
      ...(await draftOps.findByStatus('pending')),
      ...(await draftOps.findByStatus('researched')),
      ...(await draftOps.findByStatus('curated')),
      ...(await draftOps.findByStatus('drafted')),
      ...(await draftOps.findByStatus('ready')),
    ];
    const sentDrafts = await draftOps.findByStatus('sent');
    const seenNames = new Set<string>();

    for (const draft of [...pendingDrafts, ...sentDrafts]) {
      const artist = await artistOps.findById(draft.artist_id);
      if (!artist?.full_name) {
        continue;
      }

      seenNames.add(this.normalizeArtistName(artist.full_name));
    }

    return seenNames;
  }

  private async loadUniqueReadyPendingDrafts(
    email: EmailModule
  ): Promise<Array<Awaited<ReturnType<typeof draftOps.findReadyPendingDrafts>>[number]>> {
    const readyPendingDrafts = await draftOps.findReadyPendingDrafts(MIN_APPROVAL_IMAGES);
    const dedupedDrafts = await this.pruneDuplicatePendingDraftsByArtistName(readyPendingDrafts);
    const historicallyUsedNames = await this.getPreviouslySentArtistNames();
    const externallyPublishedHaystacks = await this.getPublishedBlogHaystacks();
    const validDrafts: typeof dedupedDrafts = [];

    for (const draft of dedupedDrafts) {
      const artist = await artistOps.findById(draft.artist_id);
      const normalizedName = artist?.full_name ? this.normalizeArtistName(artist.full_name) : '';
      const artistMetadata = artistOps.parseMetadata(artist);

      if (
        normalizedName &&
        (historicallyUsedNames.has(normalizedName) ||
          (artist?.full_name &&
            this.isArtistPublishedInExternalBlog(artist.full_name, externallyPublishedHaystacks)))
      ) {
        if (draft.id) {
          try {
            await draftOps.delete(draft.id);
            this.logger.warn(
              `Deleted stale pending draft ${draft.id} for already-used artist ${artist?.full_name ?? draft.artist_id}`
            );
          } catch (error) {
            this.logger.warn(`Failed to delete stale pending draft ${draft.id}`, error);
          }
        }
        continue;
      }

      if (artistMetadata.editor_rejected) {
        if (draft.id) {
          try {
            await draftOps.delete(draft.id);
            this.logger.warn(
              `Deleted stale pending draft ${draft.id} because artist ${artist?.full_name ?? draft.artist_id} was editor-rejected`
            );
          } catch (error) {
            this.logger.warn(`Failed to delete editor-rejected pending draft ${draft.id}`, error);
          }
        }
        continue;
      }

      if (!this.isDraftEditoriallyReady(draft, artist?.full_name)) {
        if (draft.id) {
          try {
            await draftOps.delete(draft.id);
            this.logger.warn(
              `Deleted stale pending draft ${draft.id} because it was not editorially ready`
            );
          } catch (error) {
            this.logger.warn(`Failed to delete non-ready pending draft ${draft.id}`, error);
          }
        }
        continue;
      }

      const sendability = await email.assessDraftSendability({
        draftId: draft.id!,
        images: draft.parsedImages,
        bypassDailyCap: true,
      });

      if (!sendability.sendable) {
        if (draft.id) {
          try {
            await draftOps.delete(draft.id);
            this.logger.warn(
              `Deleted stale pending draft ${draft.id} because it was not actually sendable now: ${sendability.reason ?? 'unknown reason'}`
            );
          } catch (error) {
            this.logger.warn(`Failed to delete unsendable pending draft ${draft.id}`, error);
          }
        }
        continue;
      }

      draft.parsedImages = sendability.approvalReadyImages ?? draft.parsedImages;
      validDrafts.push(draft);
    }

    return validDrafts;
  }

  private isResearchCacheImportedArtist(artist: Artist): boolean {
    const metadata = artistOps.parseMetadata(artist);
    return Boolean(
      metadata.research_cache_imported_at ||
        metadata.research_cache_mined_at ||
        metadata.curated
    );
  }

  private async prehydrateVisualReadyArtists(
    artists: Artist[],
    visual: VisualModule,
    limit: number
  ): Promise<void> {
    const ordered = await this.rankArtistsForVariety(artists);
    let hydrated = 0;

    for (const artist of ordered) {
      if (hydrated >= limit) {
        break;
      }

      const metadata = artistOps.parseMetadata(artist) as ArtistWorkflowMetadata;
      if (this.getVisualReadyImagesFromMetadata(metadata).length >= MIN_APPROVAL_IMAGES) {
        continue;
      }

      if (this.isArtistCoolingDown(artist)) {
        continue;
      }

      try {
        const result = await this.ensureArtistVisualReady(artist, visual, metadata);
        hydrated += 1;
        this.logger.info(
          `Visual prepass for ${artist.full_name}: ${result.images.length} approval-ready image(s), state=${result.ready ? 'ready' : 'pending'}`
        );
      } catch (error) {
        this.logger.warn(`Visual prepass failed for artist ${artist.full_name}`, error);
      }
    }
  }

  private async ensureArtistVisualReady(
    artist: Artist,
    visual: VisualModule,
    metadataInput?: Record<string, unknown>
  ): Promise<{ ready: boolean; images: Image[] }> {
    const metadata = (metadataInput ?? artistOps.parseMetadata(artist)) as ArtistWorkflowMetadata;
    const cachedReadyImages = this.getVisualReadyImagesFromMetadata(metadata);
    if (cachedReadyImages.length >= MIN_APPROVAL_IMAGES) {
      return {
        ready: true,
        images: cachedReadyImages.slice(0, MIN_APPROVAL_IMAGES),
      };
    }

    const artistSources = await sourceOps.findByArtistId(artist.id!);
    const images = await this.withTimeout(
      visual.sourceImages(
        {
          full_name: artist.full_name,
          visual_practice: artist.visual_practice ?? undefined,
          birthplace_city: artist.birthplace_city ?? undefined,
          birthplace_state: artist.birthplace_state ?? undefined,
          artwork_candidates: Array.isArray(metadata.research_cache_artwork_candidates)
            ? metadata.research_cache_artwork_candidates as Array<{
                pageUrl: string;
                imageUrl?: string;
                title?: string;
                sourceDomain?: string;
                confidence?: number;
              }>
            : undefined,
        },
        artistSources,
        0,
        MIN_APPROVAL_IMAGES
      ),
      IMAGE_SOURCING_TIMEOUT_MS,
      `Image sourcing timed out for artist ${artist.full_name}`
    );

    const approvalCheck = await visual.filterApprovalImages(
      {
        full_name: artist.full_name,
        visual_practice: artist.visual_practice ?? undefined,
        birthplace_city: artist.birthplace_city ?? undefined,
        birthplace_state: artist.birthplace_state ?? undefined,
      },
      images
    );
    const approvedImages = approvalCheck.accepted.slice(0, MIN_APPROVAL_IMAGES);

    const patch: ArtistWorkflowMetadata = {
      visual_ready_last_attempt_at: new Date().toISOString(),
      visual_ready_last_image_count: approvedImages.length,
      visual_ready_failure_reason:
        approvedImages.length >= MIN_APPROVAL_IMAGES
          ? ''
          : `Only ${approvedImages.length} approval-ready image(s) found`,
    };

    if (approvedImages.length >= MIN_APPROVAL_IMAGES) {
      patch.visual_ready_state = 'ready';
      patch.visual_ready_at = new Date().toISOString();
      patch.visual_ready_images = approvedImages;
      patch.visual_ready_failure_count = 0;
      patch.visual_ready_blocked_until = '';
    } else {
      const currentFailures = Number(metadata.visual_ready_failure_count ?? 0) || 0;
      patch.visual_ready_state = 'failed';
      patch.visual_ready_images = [];
      patch.visual_ready_failure_count = currentFailures + 1;
      patch.visual_ready_blocked_until = this.buildCooldownIso(
        currentFailures + 1 >= ARTIST_HARD_FAILURE_THRESHOLD
          ? ARTIST_FAILURE_COOLDOWN_HOURS * 4
          : ARTIST_FAILURE_COOLDOWN_HOURS
      );
    }

    await artistOps.mergeMetadata(artist.id!, patch);

    return {
      ready: approvedImages.length >= MIN_APPROVAL_IMAGES,
      images: approvedImages,
    };
  }

  private getVisualReadyImagesFromMetadata(metadata: ArtistWorkflowMetadata): Image[] {
    if (!Array.isArray(metadata.visual_ready_images)) {
      return [];
    }

    return metadata.visual_ready_images.filter((image): image is Image => {
      return Boolean(
        image &&
          typeof image === 'object' &&
          typeof image.url === 'string' &&
          typeof image.attribution === 'string'
      );
    });
  }

  private isArtistCoolingDown(artist: Artist): boolean {
    const metadata = artistOps.parseMetadata(artist) as ArtistWorkflowMetadata;
    const blockedUntilCandidates = [
      metadata.visual_ready_blocked_until,
      metadata.editorial_blocked_until,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value));

    if (blockedUntilCandidates.some((value) => value > Date.now())) {
      return true;
    }

    const visualFailures = Number(metadata.visual_ready_failure_count ?? 0) || 0;
    const editorialFailures = Number(metadata.editorial_failure_count ?? 0) || 0;
    return visualFailures >= ARTIST_HARD_FAILURE_THRESHOLD * 2 || editorialFailures >= ARTIST_HARD_FAILURE_THRESHOLD * 2;
  }

  private buildCooldownIso(hours: number): string {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }

  private async bumpArtistFailureMetadata(
    artistId: number,
    kind: 'visual' | 'editorial',
    reason: string,
    workflowDate: string
  ): Promise<void> {
    const artist = await artistOps.findById(artistId);
    const metadata = artistOps.parseMetadata(artist) as ArtistWorkflowMetadata;
    const now = new Date().toISOString();

    if (kind === 'visual') {
      const failureCount = (Number(metadata.visual_ready_failure_count ?? 0) || 0) + 1;
      await artistOps.mergeMetadata(artistId, {
        visual_ready_state: 'failed',
        visual_ready_failure_count: failureCount,
        visual_ready_failure_reason: reason,
        visual_ready_last_attempt_at: now,
        visual_ready_blocked_until: this.buildCooldownIso(
          failureCount >= ARTIST_HARD_FAILURE_THRESHOLD
            ? ARTIST_FAILURE_COOLDOWN_HOURS * 4
            : ARTIST_FAILURE_COOLDOWN_HOURS
        ),
        last_workflow_failure_at: now,
        last_workflow_failure_date: workflowDate,
        last_workflow_failure_reason: reason,
      });
      return;
    }

    const failureCount = (Number(metadata.editorial_failure_count ?? 0) || 0) + 1;
    await artistOps.mergeMetadata(artistId, {
      editorial_failure_count: failureCount,
      editorial_failure_reason: reason,
      editorial_failure_at: now,
      editorial_blocked_until: this.buildCooldownIso(
        failureCount >= ARTIST_HARD_FAILURE_THRESHOLD
          ? ARTIST_FAILURE_COOLDOWN_HOURS * 2
          : ARTIST_FAILURE_COOLDOWN_HOURS
      ),
      last_workflow_failure_at: now,
      last_workflow_failure_date: workflowDate,
      last_workflow_failure_reason: reason,
    });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private isDraftEditoriallyReady(
    draft: { title: string; content: string },
    artistName?: string
  ): boolean {
    const normalizedArtistName = artistName ? this.normalizeArtistName(artistName) : '';
    const normalizedTitle = this.normalizeArtistName(draft.title ?? '');
    const words = (draft.content ?? '').split(/\s+/).filter(Boolean).length;
    const paragraphs = (draft.content ?? '')
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    if (words < MIN_APPROVAL_WORDS) {
      return false;
    }

    if (paragraphs.length === 0 || paragraphs.length > MAX_APPROVAL_PARAGRAPHS) {
      return false;
    }

    if (normalizedArtistName && !normalizedTitle.includes(normalizedArtistName)) {
      return false;
    }

    return true;
  }

  private hasEditorialSourceDepth(sources: Awaited<ReturnType<typeof sourceOps.findByArtistId>>): boolean {
    const eligibleSources = sources.filter(
      (source) => !this.isSocialSource(source.url, source.institution)
    );
    const richSources = eligibleSources.filter(
      (source) => (source.content_summary?.trim().length ?? 0) >= 320
    );

    if (richSources.length >= 2 && eligibleSources.length >= 3) {
      return true;
    }

    const institutionalRichSources = richSources.filter(
      (source) => (source.credibility_score ?? 0) >= 0.8
    );
    return institutionalRichSources.length >= 1 && richSources.length >= 2;
  }

  private shouldPersistDiscoveredSource(
    candidateUrl: string,
    parentUrl: string,
    artistName: string
  ): boolean {
    try {
      const candidate = new URL(candidateUrl);
      const parent = new URL(parentUrl);
      const normalizedCandidate = this.normalizeArtistName(candidateUrl);
      const normalizedArtist = this.normalizeArtistName(artistName);

      if (!['http:', 'https:'].includes(candidate.protocol)) {
        return false;
      }

      if (this.isSocialLikeUrl(candidateUrl)) {
        return false;
      }

      const sameHost = candidate.hostname === parent.hostname;
      const path = candidate.pathname.toLowerCase();
      const artistSlug = normalizedArtist.replace(/\s+/g, '-');

      const artistTargeted =
        normalizedCandidate.includes(normalizedArtist) ||
        path.includes(artistSlug) ||
        path.includes('/artista/') ||
        path.includes('/artist/') ||
        path.includes('/obras/') ||
        path.includes('/works/') ||
        path.includes('/artwork/');

      if (!artistTargeted) {
        return false;
      }

      if (!sameHost && getInstitutionCredibility(candidateUrl, this.ensureConfig().institutions) <= 0) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private isSocialLikeUrl(url: string): boolean {
    const normalized = url.toLowerCase();
    return [
      'instagram.com',
      'facebook.com',
      'x.com',
      'twitter.com',
      'youtube.com',
      'youtu.be',
      'tiktok.com',
      'pinterest.com',
      'linkedin.com',
    ].some((host) => normalized.includes(host));
  }

  private async pruneDuplicatePendingDraftsByArtistName<T extends { id?: number; artist_id: number }>(
    drafts: T[]
  ): Promise<T[]> {
    const deduped: T[] = [];
    const seenNames = new Set<string>();

    for (const draft of drafts) {
      const artist = await artistOps.findById(draft.artist_id);
      const normalizedName = artist?.full_name ? this.normalizeArtistName(artist.full_name) : '';

      if (!normalizedName) {
        deduped.push(draft);
        continue;
      }

      if (seenNames.has(normalizedName)) {
        if (draft.id) {
          try {
            await draftOps.delete(draft.id);
            this.logger.warn(
              `Deleted duplicate pending draft ${draft.id} for artist ${artist?.full_name ?? draft.artist_id}`
            );
          } catch (error) {
            this.logger.warn(`Failed to delete duplicate pending draft ${draft.id}`, error);
          }
        }
        continue;
      }

      seenNames.add(normalizedName);
      deduped.push(draft);
    }

    return deduped;
  }

  private normalizeArtistName(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  private buildPublicationMatchVariants(name: string): string[] {
    const normalized = this.normalizeArtistName(name);
    if (!normalized) {
      return [];
    }

    const tokens = normalized.split(' ').filter(Boolean);
    const variants = new Set<string>([normalized]);

    if (tokens.length >= 2) {
      variants.add(tokens.slice(-2).join(' '));
    }

    if (tokens.length >= 3) {
      variants.add(tokens.slice(-3).join(' '));
    }

    return Array.from(variants).filter((variant) => variant.length >= 8);
  }

  private isPotentialDuplicateName(candidate: string, blockedNames: string[]): boolean {
    if (!candidate || blockedNames.length === 0) return false;
    const candidateTokens = candidate.split(' ').filter(Boolean);
    for (const blocked of blockedNames) {
      if (!blocked) continue;
      if (candidate === blocked) return true;
      if (candidate.includes(blocked) || blocked.includes(candidate)) return true;

      const blockedTokens = blocked.split(' ').filter(Boolean);
      if (blockedTokens.length === 0) continue;
      const overlap = candidateTokens.filter((token) => blockedTokens.includes(token)).length;
      const maxLen = Math.max(candidateTokens.length, blockedTokens.length);
      if (maxLen > 0 && overlap / maxLen >= 0.8) {
        return true;
      }
    }
    return false;
  }

  private async getPublishedBlogHaystacks(): Promise<string[]> {
    try {
      return await this.ensurePublicationHistory().getPublishedPostHaystacks();
    } catch (error) {
      this.logger.warn('Failed to load external publication history', error);
      return [];
    }
  }

  private isArtistPublishedInExternalBlog(
    artistName: string,
    publishedHaystacks: string[]
  ): boolean {
    if (publishedHaystacks.length === 0) {
      return false;
    }

    const variants = this.buildPublicationMatchVariants(artistName);
    if (variants.length === 0) {
      return false;
    }

    return publishedHaystacks.some((haystack) =>
      variants.some((variant) => haystack.includes(variant))
    );
  }

  private async getFallbackExcludedArtistIds(
    pendingReplacementRequests: PendingReplacementRequest[]
  ): Promise<Set<number>> {
    const excluded = new Set<number>();
    const readyPendingDrafts = await draftOps.findReadyPendingDrafts(MIN_APPROVAL_IMAGES);

    for (const draft of readyPendingDrafts) {
      excluded.add(draft.artist_id);
    }

    for (const request of pendingReplacementRequests) {
      const rejectedDraft = await draftOps.findById(request.draftId);
      if (rejectedDraft) {
        excluded.add(rejectedDraft.artist_id);
      }
    }

    return excluded;
  }

  private async resolveOutstandingApprovalDraft(email: EmailModule) {
    const outstandingDraft = await draftOps.findOutstandingSent();
    if (!outstandingDraft?.id) {
      return null;
    }

    const draftWithImages = await draftOps.findByIdWithImages(outstandingDraft.id);
    if (!draftWithImages) {
      return null;
    }

    const sendability = await email.assessDraftSendability({
      draftId: draftWithImages.id!,
      images: draftWithImages.parsedImages,
      bypassDailyCap: true,
    });

    if (sendability.sendable) {
      return draftWithImages;
    }

    if (
      sendability.reason?.includes('editor-rejected artist') ||
      sendability.reason?.includes('rejected draft') ||
      sendability.reason?.includes('already-published artist')
    ) {
      await draftOps.updateStatus(draftWithImages.id!, 'rejected');
      this.logger.warn(
        `Demoted stale sent draft ${draftWithImages.id} because it no longer counts as an active approval item: ${sendability.reason}`
      );
    }

    return null;
  }

  private isNormalSendWindowOpen(appTimezone?: string): boolean {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      hour: '2-digit',
      hour12: false,
    });
    const hour = Number(formatter.format(new Date()));
    return hour >= NORMAL_SEND_HOUR;
  }

  private async getFailedArtistNamesForDate(workflowDate: string): Promise<Set<string>> {
    try {
      const filePath = this.getFailedArtistsFilePath(workflowDate);
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        return new Set<string>();
      }

      return new Set(
        parsed
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => this.normalizeArtistName(value))
      );
    } catch {
      return new Set<string>();
    }
  }

  private async recordFailedArtistForDate(artistName: string, workflowDate: string): Promise<void> {
    const normalized = this.normalizeArtistName(artistName);
    if (!normalized) return;

    const filePath = this.getFailedArtistsFilePath(workflowDate);
    const failedArtists = await this.getFailedArtistNamesForDate(workflowDate);
    failedArtists.add(normalized);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(Array.from(failedArtists).sort(), null, 2));
  }

  private getFailedArtistsFilePath(workflowDate: string): string {
    return path.join(process.cwd(), 'logs', 'daily', `failed-artists-${workflowDate}.json`);
  }

  private ensureConfig(): ReturnType<typeof getConfig> {
    if (!this.config) {
      this.config = getConfig();
      this.logger = new Logger('./logs', this.config.env.logLevel);
    }

    return this.config;
  }

  private ensurePublicationHistory(): PublicationHistoryModule {
    if (!this.publicationHistory) {
      const config = this.ensureConfig();
      this.publicationHistory = new PublicationHistoryModule({
        rssUrl: config.env.rssUrl,
        hashnodeApiKey: config.env.hashnodeApiKey,
        hashnodePublicationId: config.env.hashnodePublicationId,
      });
    }

    return this.publicationHistory;
  }

  private isSocialSource(url: string, institution = ''): boolean {
    const normalizedInstitution = institution.toLowerCase();
    if (
      normalizedInstitution.includes('instagram') ||
      normalizedInstitution.includes('pinterest') ||
      normalizedInstitution.includes('facebook') ||
      normalizedInstitution.includes('twitter') ||
      normalizedInstitution.includes('x.com') ||
      normalizedInstitution.includes('tiktok')
    ) {
      return true;
    }

    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const socialHosts = [
        'instagram.com',
        'facebook.com',
        'pinterest.com',
        'x.com',
        'twitter.com',
        'tiktok.com',
        'tumblr.com',
      ];

      return socialHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }
}
