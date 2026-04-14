/**
 * Scraper Bridge Module
 *
 * Bridges TypeScript with Python Scrapling scripts via child_process.
 * Provides graceful fallback — if Python/Scrapling is not installed,
 * isAvailable() returns false and callers should use existing scrapers.
 */

import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ImageSearchResult, ImageExtractionResult, PageFetchResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRAPERS_DIR = path.resolve(__dirname, '../../../scrapers');
const VENV_PYTHON = path.join(SCRAPERS_DIR, '.venv', 'bin', 'python3');
const TIMEOUT_MS = 60_000;

export class ScraperBridge {
  private imageAvailabilityCache: boolean | null = null;
  private pageAvailabilityCache: boolean | null = null;

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
          'import importlib.util, os',
          'mods = ("scrapling", "goose3", "crawl4ai")',
          'available = any(importlib.util.find_spec(mod) for mod in mods) or bool(os.getenv("FIRECRAWL_API_KEY"))',
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
    limit = 5
  ): Promise<ImageSearchResult> {
    try {
      const output = await this.runPython('search_images.py', [query, engine, String(limit)]);
      const result = JSON.parse(output) as ImageSearchResult;
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
      const output = await this.runPython('extract_images.py', [url, String(minWidth), String(maxImages)]);
      const result = JSON.parse(output) as ImageExtractionResult;
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
      const output = await this.runPython('fetch_page.py', [url, String(maxLength)]);
      const result = JSON.parse(output) as PageFetchResult;
      return result;
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
}

export type { ImageSearchResult, ImageExtractionResult, ExtractedImage, PageFetchResult, ScrapedImage } from './types.js';
