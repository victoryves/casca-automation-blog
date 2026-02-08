/**
 * TypeScript Type Definitions
 *
 * Core types for the CASCA Editorial Agent system.
 */

import { z } from 'zod';

// ============================================================================
// Database Entity Types
// ============================================================================

export const ArtistStatusSchema = z.enum(['discovered', 'verified', 'published']);
export type ArtistStatus = z.infer<typeof ArtistStatusSchema>;

export const ArtistSchema = z.object({
  id: z.number().optional(),
  full_name: z.string(),
  birthplace_city: z.string().optional(),
  birthplace_state: z.string().optional(),
  visual_practice: z.string().optional(),
  status: ArtistStatusSchema.default('discovered'),
  discovered_at: z.string().optional(),
  published_at: z.string().optional().nullable(),
  metadata: z.string().optional().nullable(),
});

export type Artist = z.infer<typeof ArtistSchema>;

export const SourceSchema = z.object({
  id: z.number().optional(),
  artist_id: z.number(),
  url: z.string().url(),
  institution: z.string(),
  credibility_score: z.number().min(0).max(1).default(1.0),
  content_summary: z.string().optional(),
  scraped_at: z.string().optional(),
});

export type Source = z.infer<typeof SourceSchema>;

export const DraftStatusSchema = z.enum(['pending', 'sent', 'approved', 'rejected']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export const ImageSchema = z.object({
  url: z.string().url(),
  caption: z.string().optional(),
  attribution: z.string(),
  local_path: z.string().optional(),
});

export type Image = z.infer<typeof ImageSchema>;

export const DraftSchema = z.object({
  id: z.number().optional(),
  artist_id: z.number(),
  title: z.string(),
  subtitle: z.string().optional(),
  content: z.string(),
  images: z.string().optional(), // JSON stringified Image[]
  created_at: z.string().optional(),
  sent_at: z.string().optional().nullable(),
  status: DraftStatusSchema.default('pending'),
});

export type Draft = z.infer<typeof DraftSchema>;

export const PublishingLogSchema = z.object({
  id: z.number().optional(),
  draft_id: z.number(),
  medium_url: z.string().url().optional().nullable(),
  published_at: z.string().optional(),
  error_message: z.string().optional().nullable(),
});

export type PublishingLog = z.infer<typeof PublishingLogSchema>;

// ============================================================================
// API Response Types
// ============================================================================

export const TavilySearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  content: z.string(),
  score: z.number().optional(),
  published_date: z.string().optional(),
});

export type TavilySearchResult = z.infer<typeof TavilySearchResultSchema>;

export const TavilyResponseSchema = z.object({
  query: z.string(),
  results: z.array(TavilySearchResultSchema),
});

export type TavilyResponse = z.infer<typeof TavilyResponseSchema>;

export const WikimediaImageSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  thumb_url: z.string().url().optional(),
});

export type WikimediaImage = z.infer<typeof WikimediaImageSchema>;

// ============================================================================
// Configuration Types
// ============================================================================

export const InstitutionSchema = z.object({
  domain: z.string(),
  name: z.string(),
  credibility_score: z.number().min(0).max(1),
  country: z.string().optional(),
});

export type Institution = z.infer<typeof InstitutionSchema>;

export const InstitutionsConfigSchema = z.object({
  institutions: z.array(InstitutionSchema),
});

export type InstitutionsConfig = z.infer<typeof InstitutionsConfigSchema>;

export const ArticlePromptSchema = z.object({
  system: z.string(),
  user_template: z.string(),
});

export type ArticlePrompt = z.infer<typeof ArticlePromptSchema>;

export const PromptsConfigSchema = z.object({
  article_generation: ArticlePromptSchema,
  fact_check: z.string().optional(),
});

export type PromptsConfig = z.infer<typeof PromptsConfigSchema>;

export const SearchQuerySchema = z.object({
  query: z.string(),
  description: z.string(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchQueriesConfigSchema = z.object({
  queries: z.array(SearchQuerySchema),
});

export type SearchQueriesConfig = z.infer<typeof SearchQueriesConfigSchema>;

// ============================================================================
// Workflow Types
// ============================================================================

export interface DiscoveryResult {
  candidates: Artist[];
  sources: Map<number, Source[]>;
  errors: string[];
}

export interface VerificationResult {
  verified: boolean;
  artist: Artist;
  sources: Source[];
  reasons: string[];
}

export interface SynthesisResult {
  draft: Draft;
  images: Image[];
  metadata: {
    sources_used: number;
    word_count: number;
    generation_time_ms: number;
  };
}

export interface PublishingResult {
  success: boolean;
  draft_id: number;
  medium_url?: string;
  error?: string;
}

export interface WorkflowState {
  date: string;
  email_sent: boolean;
  artist_id?: number;
  draft_id?: number;
  status: 'idle' | 'discovering' | 'verifying' | 'synthesizing' | 'emailing' | 'awaiting_approval' | 'publishing' | 'completed' | 'error';
  errors: string[];
}

// ============================================================================
// Email Types
// ============================================================================

export const EmailApprovalSchema = z.object({
  from: z.string().email(),
  subject: z.string(),
  body: z.string(),
  received_at: z.string(),
});

export type EmailApproval = z.infer<typeof EmailApprovalSchema>;

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

// ============================================================================
// Utility Types
// ============================================================================

export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}
