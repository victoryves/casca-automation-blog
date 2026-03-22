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
  type InstitutionsConfig,
  type PromptsConfig,
  type SearchQueriesConfig,
} from '../types/index.js';

// Load environment variables
dotenv.config();

// ============================================================================
// Environment Variables
// ============================================================================

export interface EnvConfig {
  // Database
  supabaseUrl: string;
  supabaseKey: string;

  // APIs
  geminiApiKey: string;
  resendApiKey: string;
  tavilyApiKey: string;
  wikimediaApiKey?: string;

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
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'GEMINI_API_KEY',
    'RESEND_API_KEY',
    'TAVILY_API_KEY',
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
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseKey: process.env.SUPABASE_KEY!,
    geminiApiKey: process.env.GEMINI_API_KEY!,
    resendApiKey: process.env.RESEND_API_KEY!,
    tavilyApiKey: process.env.TAVILY_API_KEY!,
    wikimediaApiKey: process.env.WIKIMEDIA_API_KEY,
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

  configCache = {
    env,
    institutions,
    prompts,
    searchQueries,
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
