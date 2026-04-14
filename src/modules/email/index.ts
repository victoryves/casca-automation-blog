/**
 * Email Module
 *
 * Handles email sending and receiving using Resend.
 */

import { Resend } from 'resend';
import { htmlToText } from 'html-to-text';
import { marked } from 'marked';
import { draftOps, artistOps, sourceOps } from '../../db/operations/index.js';
import { getConfig } from '../../config/index.js';
import { PublicationHistoryModule } from '../publication-history/index.js';
import type { Draft, Image, EmailTemplate } from '../../types/index.js';

export interface SendApprovalEmailOptions {
  draftId: number;
  images?: Image[];
}

interface PreparedAttachment {
  filename: string;
  content: string;
  content_id: string;
  disposition: 'inline';
  type: string;
}

interface PreparedImageOption {
  image: Image;
  attachment: PreparedAttachment;
}

const TARGET_APPROVAL_IMAGES = 3;
const MIN_APPROVAL_IMAGES = 3;

export class EmailModule {
  private client: Resend;
  private publicationHistory: PublicationHistoryModule | null;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
    this.publicationHistory = null;
  }

  /**
   * Send approval email with article preview
   */
  async sendApprovalEmail(options: SendApprovalEmailOptions): Promise<void> {
    const config = getConfig();
    const draft = await draftOps.findById(options.draftId);

    if (!draft) {
      throw new Error(`Draft ${options.draftId} not found`);
    }

    const artist = await artistOps.findById(draft.artist_id);
    if (!artist) {
      throw new Error(`Artist ${draft.artist_id} not found`);
    }

    await this.assertArtistNotPreviouslyPublished(artist.full_name);

    const existingDrafts = await draftOps.findByArtistId(draft.artist_id);
    const activeSentDraft = existingDrafts.find(
      (existingDraft) => existingDraft.id !== options.draftId && existingDraft.status === 'sent'
    );

    if (activeSentDraft) {
      throw new Error(
        `Refusing to send duplicate approval email: draft ${activeSentDraft.id} is already in sent status for artist ${draft.artist_id}`
      );
    }

    console.log(`\n📧 Sending approval email for: ${draft.title}`);

    // Get sources for the artist
    const sources = await sourceOps.findByArtistId(draft.artist_id);
    console.log(`  Found ${sources?.length || 0} sources for artist ID ${draft.artist_id}`);
    if (sources && sources.length > 0) {
      sources.forEach((s, i) => {
        console.log(`    Source ${i + 1}: ${s.institution} - ${s.url}`);
      });
    }

    try {
      // Prepare attachments FIRST to know which images succeeded
      let attachments: PreparedAttachment[] = [];
      let successfulImages: Image[] = [];
      let preparedImageOptions: PreparedImageOption[] = [];

      if (!options.images || options.images.length < MIN_APPROVAL_IMAGES) {
        throw new Error(
          `Refusing to send approval email with fewer than ${MIN_APPROVAL_IMAGES} images`
        );
      }

      if (options.images.length > 0) {
        console.log(`  Downloading ${options.images.length} images...`);
        const result = await this.prepareImageAttachments(options.images);
        attachments = result.attachments;
        successfulImages = result.validatedImages;
        preparedImageOptions = result.preparedImageOptions;
      }

      if (successfulImages.length < MIN_APPROVAL_IMAGES) {
        throw new Error(
          `Refusing to send approval email with only ${successfulImages.length} validated images`
        );
      }

      if (successfulImages.length < TARGET_APPROVAL_IMAGES) {
        console.log(
          `  ⚠ Sending with ${successfulImages.length} images (preferred target is ${TARGET_APPROVAL_IMAGES})`
        );
      }

      // Generate email template with only successful images
      const template = await this.generateApprovalTemplate(
        draft,
        artist.full_name,
        successfulImages,
        sources,
        options.draftId,
        preparedImageOptions
      );

      const result = await this.client.emails.send({
        from: config.env.fromEmail,
        replyTo: 'approve@casca-archive.org',
        to: config.env.approvalEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      console.log(`  ✓ Email sent:`, result.data);

      // Save ONLY successful images to draft (for later publishing)
      if (successfulImages.length > 0) {
        await draftOps.updateImages(options.draftId, successfulImages);
        console.log(`  ✓ Saved ${successfulImages.length} validated images to draft`);
      }

      // Update draft status
      await draftOps.updateStatus(options.draftId, 'sent');
      console.log(`  ✓ Draft marked as sent`);
    } catch (error) {
      console.error('Failed to send email:', error);
      throw new Error(
        `Email sending failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async assertArtistNotPreviouslyPublished(artistName: string): Promise<void> {
    const haystacks = await this.ensurePublicationHistory().getPublishedPostHaystacks();
    if (haystacks.length === 0) {
      return;
    }

    if (this.isArtistPublishedInExternalBlog(artistName, haystacks)) {
      throw new Error(
        `Refusing to send approval email for already-published artist ${artistName}`
      );
    }
  }

  private ensurePublicationHistory(): PublicationHistoryModule {
    if (!this.publicationHistory) {
      const config = getConfig();
      this.publicationHistory = new PublicationHistoryModule({
        rssUrl: config.env.rssUrl,
        hashnodeApiKey: config.env.hashnodeApiKey,
        hashnodePublicationId: config.env.hashnodePublicationId,
      });
    }

    return this.publicationHistory;
  }

  private isArtistPublishedInExternalBlog(
    artistName: string,
    publishedHaystacks: string[]
  ): boolean {
    if (publishedHaystacks.length === 0) {
      return false;
    }

    const variants = this.buildArtistNameVariants(artistName);
    if (variants.length === 0) {
      return false;
    }

    return publishedHaystacks.some((haystack) =>
      variants.some((variant) => haystack.includes(variant))
    );
  }

  private buildArtistNameVariants(name: string): string[] {
    const normalized = this.normalizeArtistName(name);
    if (!normalized) {
      return [];
    }

    const tokens = normalized.split(' ').filter(Boolean);
    const variants = new Set<string>([normalized]);

    if (tokens.length >= 2) {
      variants.add(tokens.slice(-2).join(' '));
    }

    for (const token of tokens) {
      if (this.isDistinctiveArtistToken(token)) {
        variants.add(token);
      }
    }

    return Array.from(variants).filter(Boolean);
  }

  private normalizeArtistName(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
  }

  private isDistinctiveArtistToken(token: string): boolean {
    if (token.length < 7) {
      return false;
    }

    const commonTokens = new Set([
      'silva',
      'santos',
      'souza',
      'oliveira',
      'costa',
      'almeida',
      'rodrigues',
      'ferreira',
      'pereira',
      'barbosa',
      'amorim',
      'vieira',
      'andrade',
      'junior',
      'neto',
      'filho',
    ]);

    return !commonTokens.has(token);
  }

  /**
   * Generate approval email template
   */
  private async generateApprovalTemplate(
    draft: Draft,
    artistName: string,
    images?: Image[],
    sources?: any[],
    draftId?: number,
    preparedImageOptions?: PreparedImageOption[]
  ): Promise<EmailTemplate> {
    // Configure marked for better paragraph handling
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    let contentHtml = await marked(draft.content);

    // Insert image placeholders between paragraphs
    if (images && images.length > 0) {
      contentHtml = this.insertImagePlaceholders(contentHtml, images);
    }

    // Insert sources before Keywords section
    if (sources && sources.length > 0) {
      console.log(`  Inserting ${sources.length} sources into article content`);

      const sourcesHtml = `<br><strong>Fontes:</strong><br>${sources
  .map(
    (source, index) => `(${index + 1}) ${source.institution || 'Source'} - <a href="${source.url}" style="color: #667eea; text-decoration: underline;">${source.url}</a>`
  )
  .join('<br>')}<br><br>`;

      // Check if Keywords exists in the content
      const hasKeywords = contentHtml.toLowerCase().includes('keywords');
      console.log(`  Keywords found in content: ${hasKeywords}`);

      if (hasKeywords) {
        // Match just the Keywords line within the paragraph
        const keywordsPattern = /(<br>)?<strong>Keywords:<\/strong>/i;

        if (keywordsPattern.test(contentHtml)) {
          contentHtml = contentHtml.replace(keywordsPattern, sourcesHtml + '<strong>Keywords:</strong>');
          console.log(`  ✓ Sources inserted before Keywords`);
        } else {
          console.log(`  ⚠ Keywords found but pattern didn't match, appending sources at end`);
          contentHtml += sourcesHtml;
        }
      } else {
        console.log(`  ⚠ No Keywords found, appending sources at end`);
        contentHtml += sourcesHtml;
      }
    }

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${draft.title}</title>
  <style>
    * {
      font-family: 'Courier New', Courier, monospace !important;
    }
    body {
      font-family: 'Courier New', Courier, monospace !important;
      line-height: 1.4;
      color: #1a1a1a;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
      letter-spacing: normal;
    }
    .container {
      background-color: #ffffff;
      padding: 50px 45px;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    .header {
      text-align: center;
      padding-bottom: 25px;
      margin-bottom: 40px;
    }
    .header h1 {
      margin: 0 0 15px 0;
      font-size: 2.6em;
      font-weight: 700;
      line-height: 1.3;
      color: #000;
      letter-spacing: -0.02em;
      font-family: 'Courier New', Courier, monospace !important;
    }
    .header h2 {
      margin: 0;
      font-size: 1.56em;
      font-weight: 400;
      color: #666;
      font-style: italic;
      font-family: 'Courier New', Courier, monospace !important;
    }
    .content {
      font-size: 1.43em;
      margin-bottom: 40px;
      color: #2d2d2d;
      letter-spacing: normal;
      font-family: 'Courier New', Courier, monospace !important;
    }
    .content p {
      margin: 2.5em 0;
      line-height: 1.4;
      text-align: justify;
      font-family: 'Courier New', Courier, monospace !important;
    }
    .content p:first-of-type::first-letter {
      font-size: 3em;
      font-weight: bold;
      float: left;
      line-height: 0.9;
      margin: 0.1em 0.1em 0 0;
      color: #667eea;
    }
    .content strong {
      font-weight: 700;
      color: #000;
    }
    .content em {
      font-style: italic;
      color: #555;
    }
    .approval-section {
      background-color: #f0f0f0;
      padding: 30px;
      border-radius: 8px;
      text-align: center;
      margin-top: 40px;
    }
    .approval-section h3 {
      margin-top: 0;
      color: #000;
      font-size: 1.43em;
    }
    .approval-section p {
      font-size: 1.43em;
      margin: 15px 0;
    }
    .approval-code {
      background-color: #000;
      color: #fff;
      padding: 15px 30px;
      font-family: 'Courier New', monospace;
      font-size: 1.43em;
      font-weight: bold;
      display: inline-block;
      border-radius: 4px;
      margin: 20px 0;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      font-size: 1.43em;
      color: #666;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${draft.title}</h1>
      ${draft.subtitle ? `<h2>${draft.subtitle}</h2>` : ''}
    </div>

    <div class="content">
      ${contentHtml}
    </div>

    <div class="approval-section">
      <h3>📝 Article Ready for Review</h3>
      <p>This article about <strong>${artistName}</strong> is ready to publish.</p>
      ${this.renderApproveButtons(draftId, images, preparedImageOptions)}
      <p style="margin: 15px 0;">
        <a href="${this.buildRejectUrl(draftId)}"
           style="background-color: #fff; color: #cc0000; padding: 14px 36px; font-family: 'Courier New', monospace; font-size: 1em; font-weight: bold; text-decoration: none; border-radius: 4px; display: inline-block; border: 2px solid #cc0000;">
          REJEITAR — BUSCAR OUTRO ARTISTA
        </a>
      </p>
      <p style="font-size: 0.85em; color: #888; margin-top: 10px;">
        Publicar envia para o Hashnode. Rejeitar busca um novo artista e envia outro email.
      </p>
    </div>

    <div class="footer">
      <p>CASCA Editorial Agent • Automated Editorial Discovery</p>
      <p>Draft ID: ${draft.id} • Artist: ${artistName}</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = htmlToText(html, {
      wordwrap: 80,
      preserveNewlines: true,
    });

    // Add unique identifier to prevent Gmail threading
    const uniqueId = Date.now().toString(36);

    return {
      subject: `📰 Article Ready: ${draft.title} [${uniqueId}]`,
      html,
      text,
    };
  }

  /**
   * Insert image placeholders between paragraphs
   */
  private insertImagePlaceholders(contentHtml: string, images: Image[]): string {
    if (!images || images.length === 0) {
      return contentHtml;
    }

    // Split by <br> tags since marked generates single <p> with <br> separators
    const parts = contentHtml.split(/<br\s*\/?>/gi);

    const totalParts = parts.length;
    const imageCount = images.length;

    if (totalParts <= 1) {
      return contentHtml;
    }

    // Calculate positions to insert images (evenly distributed)
    const interval = Math.floor(totalParts / (imageCount + 1));
    const positions: number[] = [];

    for (let i = 0; i < imageCount; i++) {
      const pos = Math.min((i + 1) * interval, totalParts - 1);
      if (pos > 0) {
        positions.push(pos);
      }
    }

    // Build result with images inserted at calculated positions
    let result = '';
    let imageIndex = 0;

    for (let i = 0; i < parts.length; i++) {
      result += parts[i];

      // Check if we should insert an image after this part
      if (imageIndex < positions.length && i === positions[imageIndex]) {
        const img = images[imageIndex];
        result += `

<p style="text-align: center; margin: 2.5em 0; font-family: 'Courier New', Courier, monospace !important; line-height: 1.4;">
[Imagem do Anexo ${imageIndex + 1} - ${img.attribution}]
</p>
`;
        imageIndex++;
        // Add <br> to continue the flow
        if (i < parts.length - 1) {
          result += '<br>';
        }
      } else if (i < parts.length - 1) {
        result += '<br>';
      }
    }

    return result;
  }

  /**
   * Parse inbound email for approval
   */
  /**
   * Build one-click approval URL
   */
  private renderApproveButtons(
    draftId: number | undefined,
    images?: Image[],
    preparedImageOptions?: PreparedImageOption[]
  ): string {
    const safeImages = images ?? [];
    const buttonImages = safeImages.length > 0 ? safeImages : [{ url: '', attribution: '' } as Image];

    return buttonImages
      .map((image, index) => {
        const label = `PUBLICAR ARTIGO COM A IMAGEM ${index + 1} EM DESTAQUE`;
        const fileLabel = preparedImageOptions?.[index]?.attachment.filename ?? this.buildImageFileLabel(image, index);

        return `<div style="margin: 18px 0; display: table; width: 100%;">
        <div style="display: table-cell; width: 132px; vertical-align: middle; padding-right: 16px;">
          <div style="width: 120px; min-height: 72px; border: 1px solid #d9d9d9; border-radius: 4px; display: block; padding: 10px; box-sizing: border-box; background: #fafafa; color: #555; font-size: 0.85em; line-height: 1.35; word-break: break-word;">
            ${fileLabel}
          </div>
        </div>
        <div style="display: table-cell; vertical-align: middle; text-align: left;">
          <a href="${this.buildApproveUrl(draftId, index)}"
             style="background-color: #000; color: #fff; padding: 16px 24px; font-family: 'Courier New', monospace; font-size: 1em; font-weight: bold; text-decoration: none; border-radius: 4px; display: inline-block;">
            ${label}
          </a>
          <div style="font-size: 0.9em; color: #666; margin-top: 8px;">${image.caption ?? `Imagem ${index + 1}`}</div>
        </div>
      </div>`;
      })
      .join('\n');
  }

  private buildImageFileLabel(image: Image, index: number): string {
    try {
      const parsed = new URL(image.url);
      const rawName = parsed.pathname.split('/').pop() || '';
      return rawName || `imagem-${index + 1}`;
    } catch {
      return `imagem-${index + 1}`;
    }
  }

  private buildApproveUrl(draftId?: number, featuredImageIndex = 0): string {
    const config = getConfig();
    return this.buildActionUrl(
      'approve',
      draftId,
      config.env.webhookSecret,
      config.env.appBaseUrl ?? config.env.vercelUrl,
      featuredImageIndex
    );
  }

  private buildRejectUrl(draftId?: number): string {
    const config = getConfig();
    return this.buildActionUrl(
      'reject',
      draftId,
      config.env.webhookSecret,
      config.env.appBaseUrl ?? config.env.vercelUrl
    );
  }

  private buildActionUrl(
    action: 'approve' | 'reject',
    draftId: number | undefined,
    webhookSecret: string | undefined,
    configuredBaseUrl?: string,
    featuredImageIndex?: number
  ): string {
    if (!draftId) {
      throw new Error(`Cannot build ${action} URL without draft ID`);
    }

    if (!webhookSecret) {
      throw new Error(`Cannot build ${action} URL without WEBHOOK_SECRET`);
    }

    const baseUrl = this.normalizeBaseUrl(
      configuredBaseUrl || 'https://casca-automation-blog.vercel.app'
    );
    const url = new URL(`/api/webhook/${action}`, baseUrl);
    url.searchParams.set('draft', String(draftId));
    url.searchParams.set('token', webhookSecret);
    if (action === 'approve' && Number.isInteger(featuredImageIndex) && featuredImageIndex! >= 0) {
      url.searchParams.set('featured', String(featuredImageIndex));
    }
    const builtUrl = url.toString();

    if (!builtUrl.includes('token=')) {
      throw new Error(`Refusing to build ${action} URL without token query param`);
    }

    return builtUrl;
  }

  private normalizeBaseUrl(baseUrl: string): string {
    if (/^https?:\/\//i.test(baseUrl)) {
      return baseUrl;
    }

    return `https://${baseUrl}`;
  }

  parseApprovalReply(emailBody: string): boolean {
    // Check for approval keywords (Portuguese or English)
    const normalized = emailBody.toLowerCase().trim();
    return /\b(poste|publish)\b/.test(normalized);
  }

  /**
   * Check if email already sent today
   */
  async emailSentToday(): Promise<boolean> {
    return await draftOps.emailSentToday();
  }

  /**
   * Prepare image attachments with CID for inline embedding
   */
  private async prepareImageAttachments(images: Image[]): Promise<{
    attachments: PreparedAttachment[];
    validatedImages: Image[];
    preparedImageOptions: PreparedImageOption[];
  }> {
    const axios = (await import('axios')).default;
    const attachments: PreparedAttachment[] = [];
    const validatedImages: Image[] = [];
    const preparedImageOptions: PreparedImageOption[] = [];
    let successCount = 0;

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      try {
        // Download image with proper headers to avoid blocking
        const response = await axios.get(image.url, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.google.com/',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
          },
          maxRedirects: 5,
        });

        // Validate response has data
        if (!response.data || response.data.length === 0) {
          console.warn(`  ✗ Image ${i + 1} downloaded but has no data`);
          continue;
        }

        // Validate it's actually an image (not HTML error page)
        const contentType = response.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          console.warn(`  ✗ Image ${i + 1} returned non-image content: ${contentType}`);
          continue;
        }

        // Validate minimum size (at least 1KB for valid image)
        if (response.data.length < 1024) {
          console.warn(`  ✗ Image ${i + 1} too small (${response.data.length} bytes) - likely invalid`);
          continue;
        }

        // Convert to base64
        const base64 = Buffer.from(response.data).toString('base64');

        // Validate base64 is not empty
        if (!base64 || base64.length < 100) {
          console.warn(`  ✗ Image ${i + 1} base64 conversion failed or too small`);
          continue;
        }

        // Use successCount for consistent indexing
        const filename = this.buildAttachmentFilename(image, successCount, contentType);

        const attachment: PreparedAttachment = {
          filename,
          content: base64,
          content_id: `image${successCount}`,
          disposition: 'inline',
          type: contentType,
        };

        attachments.push(attachment);

        // Track which images were successfully validated
        validatedImages.push(image);
        preparedImageOptions.push({
          image,
          attachment,
        });

        successCount++;
        console.log(`  ✓ Attached image ${successCount}/${images.length}`);
      } catch (error) {
        console.warn(`  ✗ Failed to download image ${i + 1}: ${image.url.substring(0, 80)}...`);
      }
    }

    console.log(`  📊 Successfully attached ${successCount}/${images.length} images`);
    return { attachments, validatedImages, preparedImageOptions };
  }

  private buildAttachmentFilename(image: Image, index: number, contentType: string): string {
    const fallbackExtension = this.extensionFromContentType(contentType);
    const baseLabel = this.buildImageFileLabel(image, index).trim();
    const hasKnownExtension = /\.[a-z0-9]{2,5}$/i.test(baseLabel);
    const rawName = hasKnownExtension ? baseLabel : `${baseLabel}.${fallbackExtension}`;

    const sanitized = rawName
      .replace(/%[0-9a-f]{2}/gi, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return sanitized || `image-${index + 1}.${fallbackExtension}`;
  }

  private extensionFromContentType(contentType: string): string {
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
    return 'jpg';
  }
}
