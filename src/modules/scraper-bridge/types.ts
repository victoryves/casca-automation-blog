/**
 * Types for Python scraper bridge responses.
 */

export interface ScrapedImage {
  url: string;
  caption: string;
  source_page: string;
}

export interface ImageSearchResult {
  success: boolean;
  engine: string;
  images: ScrapedImage[];
  error?: string;
}

export interface PageFetchResult {
  success: boolean;
  url: string;
  title?: string;
  content?: string;
  content_length?: number;
  error?: string;
}

export interface ExtractedImage {
  url: string;
  alt: string;
  width?: number;
  height?: number;
  source_page: string;
}

export interface ImageExtractionResult {
  success: boolean;
  url: string;
  images: ExtractedImage[];
  error?: string;
}
