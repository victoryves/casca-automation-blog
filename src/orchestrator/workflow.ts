/**
 * Workflow Orchestrator
 *
 * Main workflow coordinator for daily execution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { initDatabase, closeDatabase } from '../db/local.js';
import { artistOps, draftOps, publishingOps, sourceOps } from '../db/operations/index.js';
import { getConfig } from '../config/index.js';
import { DiscoveryModule } from '../modules/discovery/index.js';
import { VerificationModule } from '../modules/verification/index.js';
import { SynthesisModule } from '../modules/synthesis/index.js';
import { VisualModule } from '../modules/visual/index.js';
import { EmailModule } from '../modules/email/index.js';
import { EmergencyFallbackModule } from '../modules/emergency/index.js';
import { PublishingModule } from '../modules/publishing/index.js';
import { PublicationHistoryModule } from '../modules/publication-history/index.js';
import { queueRejectedDraftReplacement } from '../modules/rejections/index.js';
import { ScraperBridge } from '../modules/scraper-bridge/index.js';
import { Logger } from '../utils/logger.js';
import type { WorkflowState, Artist } from '../types/index.js';

export interface WorkflowOptions {
  dryRun?: boolean;
  skipDiscovery?: boolean;
  forceRun?: boolean;
}

interface PendingReplacementRequest {
  logId: number;
  draftId: number;
  requestedAt: string;
}

const MIN_APPROVAL_IMAGES = 2;
const NORMAL_SEND_HOUR = 8;
const TARGET_READY_PENDING_DRAFTS = 3;

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
      const discovery = new DiscoveryModule(config.env.tavilyApiKey);
      const verification = new VerificationModule();
      const synthesis = new SynthesisModule(config.env.geminiApiKey);
      const visual = new VisualModule(config.env.geminiApiKey);
      const email = new EmailModule(config.env.resendApiKey);
      const emergencyFallback = new EmergencyFallbackModule();
      const pendingReplacementRequests = await this.getPendingReplacementRequests();
      const hasPendingReplacementRequest = pendingReplacementRequests.length > 0;
      const sendWindowOpen = this.isNormalSendWindowOpen(config.env.appTimezone);
      const blockedArtistNames = new Set<string>([
        ...(await this.getPreviouslySentArtistNames()),
        ...(await this.getOpenDraftArtistNames()),
      ]);
      let readyPendingDrafts = await this.loadUniqueReadyPendingDrafts();
      let readyPendingDraft = readyPendingDrafts[0] ?? null;
      let readyPendingCount = readyPendingDrafts.length;
      let emailSentToday = await email.emailSentToday();
      let sendStillNeeded = hasPendingReplacementRequest || (!emailSentToday && sendWindowOpen);

      if (readyPendingDraft && sendStillNeeded) {
        this.logger.info(`Sending already-prepared draft ${readyPendingDraft.id}`);
        try {
          await email.sendApprovalEmail({
            draftId: readyPendingDraft.id!,
            images: readyPendingDraft.parsedImages,
          });

          state.email_sent = true;
          state.artist_id = readyPendingDraft.artist_id;
          state.draft_id = readyPendingDraft.id;
          state.status = 'awaiting_approval';
          emailSentToday = true;
          sendStillNeeded = false;
          const preparedArtist = await artistOps.findById(readyPendingDraft.artist_id);
          if (preparedArtist?.full_name) {
            blockedArtistNames.add(this.normalizeArtistName(preparedArtist.full_name));
          }
        } catch (preparedDraftError) {
          const message =
            preparedDraftError instanceof Error
              ? preparedDraftError.message
              : String(preparedDraftError);

          const isStalePreparedDraft =
            message.includes('validated images') ||
            message.includes('fewer than') ||
            message.includes('duplicate approval email');

          if (!isStalePreparedDraft) {
            throw preparedDraftError;
          }

          this.logger.warn(
            `Discarding stale prepared draft ${readyPendingDraft.id} after send failure: ${message}`
          );
          await draftOps.delete(readyPendingDraft.id!);
        }

        readyPendingDrafts = await this.loadUniqueReadyPendingDrafts();
        readyPendingDraft = readyPendingDrafts[0] ?? null;
        readyPendingCount = readyPendingDrafts.length;

        if (state.email_sent && pendingReplacementRequests.length > 0) {
          const oldestPendingRequest = pendingReplacementRequests[0];
          await this.clearPendingReplacementRequest(oldestPendingRequest.logId);
          this.logger.info(
            `Cleared pending replacement request log ${oldestPendingRequest.logId}`
          );
        }
      }

      if (hasPendingReplacementRequest) {
        this.logger.info(
          `Pending replacement request detected (${pendingReplacementRequests.length}) - bypassing sent-today guard`
        );
      }

      if (!hasPendingReplacementRequest && emailSentToday && readyPendingCount >= TARGET_READY_PENDING_DRAFTS) {
        this.logger.info(
          `✓ Email already sent today and backlog is healthy (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS}) - skipping workflow`
        );
        state.email_sent = true;
        state.prepared_draft = readyPendingCount > 0;
        state.draft_id = readyPendingDraft?.id;
        state.status = 'completed';
        return state;
      }

      if (!hasPendingReplacementRequest && !sendWindowOpen && readyPendingCount >= TARGET_READY_PENDING_DRAFTS) {
        this.logger.info(
          `✓ Backlog already prepared before the ${NORMAL_SEND_HOUR.toString().padStart(2, '0')}:00 send window (${readyPendingCount}/${TARGET_READY_PENDING_DRAFTS})`
        );
        state.prepared_draft = true;
        state.draft_id = readyPendingDraft?.id;
        state.status = 'completed';
        return state;
      }

      const shouldPrepareOnly = !sendStillNeeded;
      let preparationSlotsNeeded = Math.max(0, TARGET_READY_PENDING_DRAFTS - readyPendingCount);

      if (shouldPrepareOnly && preparationSlotsNeeded > 0) {
        this.logger.info(
          emailSentToday
            ? `Email already sent today, preparing ${preparationSlotsNeeded} replacement draft(s) in the background`
            : `Before ${NORMAL_SEND_HOUR}:00 local time, preparing ${preparationSlotsNeeded} draft(s) without sending`
        );
      }

      if (!sendStillNeeded && preparationSlotsNeeded === 0) {
        state.prepared_draft = readyPendingCount > 0;
        state.draft_id = readyPendingDraft?.id;
        state.status = 'completed';
        return state;
      }

      // Step 2: Check for verified unpublished artists
      let verifiedArtists = await artistOps.findVerifiedUnpublished();
      verifiedArtists = await this.filterArtistsWithSources(verifiedArtists, 1, state.date, blockedArtistNames);
      this.logger.info(`Found ${verifiedArtists.length} verified unpublished artists with sources`);

      const maxDiscoveryAttempts = 10;
      let discoveryAttempts = 0;
      let completed = false;
      const fallbackExcludedArtistIds = await this.getFallbackExcludedArtistIds(pendingReplacementRequests);

      while (sendStillNeeded || preparationSlotsNeeded > 0) {
        if (verifiedArtists.length === 0) {
          if (options.skipDiscovery) {
            break;
          }

          this.logger.info('No verified artists available - starting discovery loop');
          state.status = 'discovering';

          while (verifiedArtists.length === 0 && discoveryAttempts < maxDiscoveryAttempts) {
            discoveryAttempts++;
            this.logger.info(`Discovery attempt ${discoveryAttempts}/${maxDiscoveryAttempts}`);

            const discoveryResult = await discovery.discover(5);
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
              verifiedArtists = await this.filterArtistsWithSources(verifiedArtists, 1, state.date, blockedArtistNames);

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

        try {
          await this.enrichArtistSources(selectedArtist.id!);

          this.logger.info('Starting article synthesis');
          state.status = 'synthesizing';

          const synthesisResult = await synthesis.synthesize(selectedArtist.id!);
          currentDraftId = synthesisResult.draft.id;
          if (!state.email_sent) {
            state.draft_id = synthesisResult.draft.id;
          }
          this.logger.info('Article synthesized', synthesisResult.metadata);

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

          if (images.length < MIN_APPROVAL_IMAGES) {
            await draftOps.delete(synthesisResult.draft.id!);
            await this.recordFailedArtistForDate(selectedArtist.full_name, state.date);
            await artistOps.delete(selectedArtist.id!);
            state.draft_id = undefined;
            this.logger.warn(
              `Skipping artist ${selectedArtist.id} because only ${images.length} verified pure artwork image(s) were found`
            );
            continue;
          }

          if (options.dryRun) {
            this.logger.info('DRY RUN - Skipping email send');
            completed = true;
            sendStillNeeded = false;
            preparationSlotsNeeded = Math.max(0, preparationSlotsNeeded - 1);
          } else if (sendStillNeeded) {
            this.logger.info('Sending approval email');
            state.status = 'emailing';

            await email.sendApprovalEmail({
              draftId: synthesisResult.draft.id!,
              images,
            });

            state.email_sent = true;
            state.status = 'awaiting_approval';
            state.artist_id = selectedArtist.id;
            state.draft_id = synthesisResult.draft.id;
            this.logger.info('✓ Approval email sent successfully');

            sendStillNeeded = false;
            emailSentToday = true;
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
            await draftOps.updateImages(synthesisResult.draft.id!, images);
            state.prepared_draft = true;
            if (!state.email_sent) {
              state.draft_id = synthesisResult.draft.id;
            }
            this.logger.info(`✓ Draft ${synthesisResult.draft.id} prepared and saved for the next send window`);
            readyPendingCount++;
            preparationSlotsNeeded = Math.max(0, TARGET_READY_PENDING_DRAFTS - readyPendingCount);
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
            await artistOps.delete(selectedArtist.id!);
          } catch (statusError) {
            this.logger.warn(`Failed to remove artist ${selectedArtist.id} after workflow error`, statusError);
          }
          this.logger.warn(
            `Skipping artist ${selectedArtist.id} after workflow error`,
            artistError
          );
        }
      }

      while (sendStillNeeded) {
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
          sendStillNeeded = false;
          continue;
        }

        if (sendStillNeeded) {
          await email.sendApprovalEmail({
            draftId: fallbackDraft.draftId,
            images: fallbackDraft.images,
          });

          state.email_sent = true;
          state.status = 'awaiting_approval';
          state.artist_id = fallbackDraft.artistId;
          state.draft_id = fallbackDraft.draftId;
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
        } else {
          state.prepared_draft = true;
          completed = true;
        }
      }

      if (!completed || sendStillNeeded) {
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

  private async filterArtistsWithSources(
    artists: Artist[],
    minSources: number,
    workflowDate: string,
    blockedArtistNames: Set<string> = new Set<string>()
  ): Promise<Artist[]> {
    if (artists.length === 0) return artists;

    const excludedArtistNames = await this.getPreviouslySentArtistNames();
    const openDraftArtistNames = await this.getOpenDraftArtistNames();
    const externallyPublishedHaystacks = await this.getPublishedBlogHaystacks();
    const failedArtistNames = await this.getFailedArtistNamesForDate(workflowDate);
    const filtered: Artist[] = [];

    for (const artist of artists) {
      if (!artist.id) continue;
      try {
        const normalizedArtistName = this.normalizeArtistName(artist.full_name);
        if (blockedArtistNames.has(normalizedArtistName)) {
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because this artist is blocked in the current workflow run`
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

        if (failedArtistNames.has(normalizedArtistName)) {
          this.logger.warn(
            `Skipping artist ${artist.id} (${artist.full_name}) because this artist already failed image sourcing today`
          );
          continue;
        }

        const drafts = await draftOps.findByArtistId(artist.id);
        const hasOpenDraft = drafts.some((draft) => draft.status === 'pending' || draft.status === 'sent');
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

    return filtered;
  }

  private async rankArtistsForVariety(artists: Artist[]): Promise<Artist[]> {
    if (artists.length <= 1) {
      return artists;
    }

    const recentSentDrafts = await draftOps.findByStatus('sent');
    const recentPracticeCounts = new Map<string, number>();
    const recentArtistIds = new Set<number>();

    for (const draft of recentSentDrafts.slice(0, 12)) {
      recentArtistIds.add(draft.artist_id);
      const artist = await artistOps.findById(draft.artist_id);
      const practice = this.normalizePractice(artist?.visual_practice);
      recentPracticeCounts.set(practice, (recentPracticeCounts.get(practice) ?? 0) + 1);
    }

    return [...artists].sort((a, b) => {
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

    return normalized;
  }

  private async enrichArtistSources(artistId: number): Promise<void> {
    try {
      const scraperBridge = new ScraperBridge();
      if (!(await scraperBridge.isAvailable())) {
        return;
      }

      this.logger.info('Enriching sources with Scrapling');
      const sources = await sourceOps.findByArtistId(artistId);
      let enriched = 0;

      for (const source of sources) {
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
    } catch (error) {
      this.logger.warn('Source enrichment failed (non-fatal)', error);
    }
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
    const pendingDrafts = await draftOps.findByStatus('pending');
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

  private async dedupeReadyPendingDraftsByArtistName<T extends { artist_id: number }>(
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
        continue;
      }

      seenNames.add(normalizedName);
      deduped.push(draft);
    }

    return deduped;
  }

  private async loadUniqueReadyPendingDrafts(): Promise<Array<Awaited<ReturnType<typeof draftOps.findReadyPendingDrafts>>[number]>> {
    const readyPendingDrafts = await draftOps.findReadyPendingDrafts(MIN_APPROVAL_IMAGES);
    return this.pruneDuplicatePendingDraftsByArtistName(readyPendingDrafts);
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

    const normalizedArtistName = this.normalizeArtistName(artistName);
    if (!normalizedArtistName) {
      return false;
    }

    return publishedHaystacks.some((haystack) => haystack.includes(normalizedArtistName));
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
