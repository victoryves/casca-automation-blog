/**
 * Scraper Bridge Module
 *
 * Bridges TypeScript with Python Scrapling scripts via child_process.
 * Provides graceful fallback across Crawl4AI, Jina Reader, Scrapling, and Goose3.
 */

import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ImageSearchResult, ImageExtractionResult, PageFetchResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRAPERS_DIR = path.resolve(__dirname, '../../../scrapers');
const VENV_PYTHON = path.join(SCRAPERS_DIR, '.venv', 'bin', 'python3');
const TIMEOUT_MS = 30_000;
type ContentCleaner = (result: PageFetchResult) => PageFetchResult;

const ITAU_BOILERPLATE_PATTERNS = [
  /navegue pela enciclop[eé]dia/iu,
  /termos de uso/iu,
  /newsletter/iu,
  /breadcrumbs?/iu,
  /sidebar/iu,
  /ordena[cç][aã]o/iu,
  /tipo de verbete/iu,
  /verbetes relacionados/iu,
  /compartilhar/iu,
  /voltar ao topo/iu,
];

export class ScraperBridge {
  private imageAvailabilityCache: boolean | null = null;
  private pageAvailabilityCache: boolean | null = null;
  private readonly cleaningRegistry: Array<{ matches: (hostname: string) => boolean; clean: ContentCleaner }> = [
    {
      matches: (hostname) =>
        hostname === 'enciclopedia.itaucultural.org.br' || hostname.endsWith('.enciclopedia.itaucultural.org.br'),
      clean: (result) => this.cleanItauCulturalPage(result),
    },
    {
      matches: (hostname) =>
        hostname === 'itaucultural.org.br' || hostname.endsWith('.itaucultural.org.br'),
      clean: (result) => this.cleanItauCulturalPage(result),
    },
  ];

  /**
   * Check if the image scraping environment is available.
   * Image search/extraction currently depends on Scrapling.
   */
  async isAvailable(): Promise<boolean> {
    return this.isImagePipelineAvailable();
  }

  async isImagePipelineAvailable(): Promise<boolean> {
    if (this.imageAvailabilityCache !== null) {
      return this.imageAvailabilityCache;
    }

    try {
      await this.runPython('-c', ['import scrapling; print("ok")']);
      this.imageAvailabilityCache = true;
    } catch {
      this.imageAvailabilityCache = false;
    }

    return this.imageAvailabilityCache;
  }

  /**
   * Check if at least one page-fetch backend is available.
   * This supports Scrapling, Goose, Crawl4AI, or Firecrawl.
   */
  async isPageFetchAvailable(): Promise<boolean> {
    if (this.pageAvailabilityCache !== null) {
      return this.pageAvailabilityCache;
    }

    try {
      await this.runPython('-c', [
        [
          'import importlib.util',
          'mods = ("scrapling", "goose3", "crawl4ai")',
          'available = any(importlib.util.find_spec(mod) for mod in mods)',
          'print("ok" if available else "")',
        ].join('; '),
      ]);
      this.pageAvailabilityCache = true;
    } catch {
      this.pageAvailabilityCache = false;
    }

    return this.pageAvailabilityCache;
  }

  /**
   * Search for images using Scrapling-based scrapers.
   */
  async searchImages(
    query: string,
    engine: 'bing' | 'duckduckgo' | 'google' | 'all' = 'all',
    limit = 5,
    options: {
      siteFilters?: string[];
      artworkOnly?: boolean;
    } = {}
  ): Promise<ImageSearchResult> {
    try {
      const output = await this.runPythonWithRetry('search_images.py', [
        query,
        engine,
        String(limit),
        JSON.stringify(options),
      ]);
      const result = JSON.parse(this.extractJsonPayload(output)) as ImageSearchResult;
      return result;
    } catch (error) {
      console.warn('ScraperBridge.searchImages failed:', error);
      return {
        success: false,
        engine,
        images: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Extract images from a specific web page.
   */
  async extractImages(url: string, minWidth = 200, maxImages = 10): Promise<ImageExtractionResult> {
    try {
      const output = await this.runPythonWithRetry('extract_images.py', [url, String(minWidth), String(maxImages)]);
      const result = JSON.parse(this.extractJsonPayload(output)) as ImageExtractionResult;
      return result;
    } catch (error) {
      console.warn('ScraperBridge.extractImages failed:', error);
      return {
        success: false,
        url,
        images: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fetch and extract content from a web page.
   */
  async fetchPage(url: string, maxLength = 5000): Promise<PageFetchResult> {
    try {
      const output = await this.runPythonWithRetry('fetch_page.py', [url, String(maxLength)]);
      const result = JSON.parse(this.extractJsonPayload(output)) as PageFetchResult;
      return this.cleanPageResult(result);
    } catch (error) {
      console.warn('ScraperBridge.fetchPage failed:', error);
      return {
        success: false,
        url,
        final_url: url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Run a Python script from the scrapers directory.
   * Uses the venv Python if available, falls back to system python3.
   */
  private runPython(scriptOrFlag: string, args: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      // Determine Python executable and script path
      let pythonPath: string;
      let execArgs: string[];

      if (scriptOrFlag.startsWith('-')) {
        // Direct Python flag (e.g., -c "import scrapling")
        pythonPath = VENV_PYTHON;
        execArgs = [scriptOrFlag, ...args];
      } else {
        pythonPath = VENV_PYTHON;
        const scriptPath = path.join(SCRAPERS_DIR, scriptOrFlag);
        execArgs = [scriptPath, ...args];
      }

      execFile(
        pythonPath,
        execArgs,
        {
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          cwd: SCRAPERS_DIR,
        },
        (error, stdout, stderr) => {
          if (stderr) {
            console.warn(`[ScraperBridge] stderr: ${stderr.trim()}`);
          }

          if (error) {
            reject(new Error(`Python script failed: ${error.message}`));
            return;
          }

          resolve(stdout.trim());
        }
      );
    });
  }

  private async runPythonWithRetry(scriptOrFlag: string, args: string[] = []): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.runPython(scriptOrFlag, args);
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableError(error);
        const usingProxy =
          attempt >= 1 && Boolean(process.env.SCRAPER_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
        console.warn(
          `[ScraperBridge] attempt ${attempt + 1}/3 failed for ${scriptOrFlag} (proxy=${usingProxy}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (!retryable || attempt === 2) {
          break;
        }
        const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError;
  }

  private isRetryableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /403|timeout|econnreset|socket|network/i.test(message);
  }

  private extractJsonPayload(output: string): string {
    const trimmed = output.trim();
    if (trimmed.startsWith('{')) {
      return trimmed;
    }

    const successIndex = trimmed.lastIndexOf('{"success"');
    if (successIndex >= 0) {
      return trimmed.slice(successIndex);
    }

    const lines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (line.startsWith('{')) {
        return line;
      }
    }

    return trimmed;
  }

  private cleanPageResult(result: PageFetchResult): PageFetchResult {
    const targetUrl = result.final_url || result.url;
    let hostname = '';
    try {
      hostname = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      hostname = '';
    }

    const cleaner = this.cleaningRegistry.find((entry) => entry.matches(hostname));
    const cleaned = cleaner ? cleaner.clean(result) : result;

    const content = this.normalizeCleanContent(cleaned.content ?? '');
    return {
      ...cleaned,
      content,
      content_length: content.length,
    };
  }

  private cleanItauCulturalPage(result: PageFetchResult): PageFetchResult {
    const original = result.content ?? '';
    if (!original.trim()) {
      return result;
    }

    const textSectionMatch = original.match(/#\s*Texto\b[\s\S]*?(?=\n#\s*(?:Obras|Eventos|Institui[cç][aã]o|Bibliografia)\b|$)/iu);
    let content = (textSectionMatch?.[0] ?? original)
      .replace(/^#\s*Texto\b/giu, ' ')
      .replace(/Navegue pela enciclop[eé]dia[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Termos de uso[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Newsletter[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Compartilhar[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Breadcrumbs?[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Sidebar[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Ordena[cç][aã]o[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Tipo de Verbete[\s\S]*?(?=\n{2,}|$)/giu, ' ')
      .replace(/Verbetes relacionados[\s\S]*$/giu, ' ')
      .replace(/Voltar ao topo[\s\S]*$/giu, ' ');

    const paragraphs = content
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((paragraph) => !ITAU_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(paragraph)))
      .filter((paragraph) => !this.isLikelyMetadataParagraph(paragraph));

    const firstSubstantialIndex = paragraphs.findIndex((paragraph) => paragraph.length >= 220);
    const trimmedParagraphs =
      firstSubstantialIndex > 0 ? paragraphs.slice(firstSubstantialIndex) : paragraphs;

    content = trimmedParagraphs.join('\n\n').trim();

    return {
      ...result,
      content,
    };
  }

  private isLikelyMetadataParagraph(paragraph: string): boolean {
    const lower = paragraph.toLowerCase();
    if (paragraph.length <= 140) {
      return (
        lower.includes('tipo de verbete') ||
        lower.includes('ordenação') ||
        lower.includes('autoria') ||
        lower.includes('palavras-chave') ||
        lower.includes('categoria') ||
        lower.includes('tema') ||
        lower.includes('assunto') ||
        lower.includes('voltar') ||
        lower.includes('compartilhar')
      );
    }

    const metadataHits = [
      'tipo de verbete',
      'ordenação',
      'autoria',
      'palavras-chave',
      'tema',
      'assunto',
      'verbetes relacionados',
      'termos de uso',
      'newsletter',
    ].filter((token) => lower.includes(token)).length;

    return metadataHits >= 2;
  }

  private normalizeCleanContent(value: string): string {
    return value
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
}

export type { ImageSearchResult, ImageExtractionResult, ExtractedImage, PageFetchResult, ScrapedImage } from './types.js';
