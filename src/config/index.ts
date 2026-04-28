/**
 * Configuration Management
 *
 * Loads and validates configuration files and environment variables.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  InstitutionsConfigSchema,
  PromptsConfigSchema,
  SearchQueriesConfigSchema,
  EpithetsConfigSchema,
  type InstitutionsConfig,
  type PromptsConfig,
  type SearchQueriesConfig,
  type EpithetsConfig,
} from '../types/index.js';

// Load environment variables
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

// ============================================================================
// Environment Variables
// ============================================================================

export interface EnvConfig {
  // Database
  dbPath: string;

  // APIs
  geminiApiKey: string;
  resendApiKey: string;
  exaApiKey: string;
  wikimediaApiKey?: string;
  serpApiKey?: string;
  googleSearchApiKey?: string;
  googleSearchEngineId?: string;

  // Email
  approvalEmail: string;
  fromEmail: string;
  mediumImportEmail?: string;

  // Publishing
  authorName: string;
  rssUrl?: string;

  // Hashnode
  hashnodeApiKey?: string;
  hashnodePublicationId?: string;

  // Deployment
  appBaseUrl?: string;
  vercelUrl?: string;
  webhookSecret: string;
  appTimezone?: string;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function loadEnvConfig(): EnvConfig {
  const required = [
    'GEMINI_API_KEY',
    'RESEND_API_KEY',
    'EXA_API_KEY',
    'APPROVAL_EMAIL',
    'FROM_EMAIL',
    'AUTHOR_NAME',
    'WEBHOOK_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'casca.sqlite'),
    geminiApiKey: process.env.GEMINI_API_KEY!,
    resendApiKey: process.env.RESEND_API_KEY!,
    exaApiKey: process.env.EXA_API_KEY!,
    wikimediaApiKey: process.env.WIKIMEDIA_API_KEY,
    serpApiKey: process.env.SERPAPI_API_KEY,
    googleSearchApiKey: process.env.GOOGLE_SEARCH_API_KEY,
    googleSearchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID,
    approvalEmail: process.env.APPROVAL_EMAIL!,
    fromEmail: process.env.FROM_EMAIL!,
    mediumImportEmail: process.env.MEDIUM_IMPORT_EMAIL,
    authorName: process.env.AUTHOR_NAME!,
    rssUrl: process.env.RSS_URL,
    hashnodeApiKey: process.env.HASHNODE_API_KEY,
    hashnodePublicationId: process.env.HASHNODE_PUBLICATION_ID,
    appBaseUrl: process.env.APP_BASE_URL,
    vercelUrl: process.env.VERCEL_URL,
    webhookSecret: process.env.WEBHOOK_SECRET!,
    appTimezone: process.env.APP_TIMEZONE,
    logLevel: (process.env.LOG_LEVEL as EnvConfig['logLevel']) || 'info',
  };
}

// ============================================================================
// Configuration Files
// ============================================================================

function loadJsonConfig<T>(filePath: string, schema: { parse: (data: unknown) => T }): T {
  try {
    const absolutePath = path.resolve(process.cwd(), filePath);
    const fileContent = fs.readFileSync(absolutePath, 'utf-8');
    const json = JSON.parse(fileContent) as unknown;
    return schema.parse(json);
  } catch (error) {
    throw new Error(
      `Failed to load config from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ============================================================================
// Unified Config
// ============================================================================

export interface Config {
  env: EnvConfig;
  institutions: InstitutionsConfig;
  prompts: PromptsConfig;
  searchQueries: SearchQueriesConfig;
  epithets: EpithetsConfig;
}

let configCache: Config | null = null;

export function loadConfig(): Config {
  if (configCache) {
    return configCache;
  }

  const env = loadEnvConfig();
  const institutions = loadJsonConfig('config/institutions.json', InstitutionsConfigSchema);
  const prompts = loadJsonConfig('config/prompts.json', PromptsConfigSchema);
  const searchQueries = loadJsonConfig('config/search-queries.json', SearchQueriesConfigSchema);
  const epithets = loadJsonConfig('config/epithets.json', EpithetsConfigSchema);

  configCache = {
    env,
    institutions,
    prompts,
    searchQueries,
    epithets,
  };

  return configCache;
}

export function getConfig(): Config {
  if (!configCache) {
    return loadConfig();
  }
  return configCache;
}

// ============================================================================
// Validation Helpers
// ============================================================================

export function isInstitutionalDomain(url: string, config: InstitutionsConfig): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    return config.institutions.some((institution) => {
      const domain = institution.domain.toLowerCase();
      return hostname === domain || hostname.endsWith(`.${domain}`);
    });
  } catch {
    return false;
  }
}

export function getInstitutionCredibility(url: string, config: InstitutionsConfig): number {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    const institution = config.institutions.find((inst) => {
      const domain = inst.domain.toLowerCase();
      return hostname === domain || hostname.endsWith(`.${domain}`);
    });

    return institution?.credibility_score ?? 0;
  } catch {
    return 0;
  }
}

export function getInstitutionName(url: string, config: InstitutionsConfig): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    const institution = config.institutions.find((inst) => {
      const domain = inst.domain.toLowerCase();
      return hostname === domain || hostname.endsWith(`.${domain}`);
    });

    return institution?.name ?? null;
  } catch {
    return null;
  }
}
