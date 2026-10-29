/** CASCA house style: findings are editorial signals, never an AI-authorship score. */
export interface EditorialFinding { rule: string; severity: 'error' | 'warning'; message: string }
export const CASCA_EDITORIAL_VOICE = [
  'Write for an attentive reader of art and visual culture, in precise, readable English.',
  'Open with a documented work, material, gesture or problem specific to this artist. Do not force a chronological opening.',
  'Build connections between documented details. Each paragraph must advance the account rather than restate it.',
  'Discuss actual surfaces, forms, processes and works when the evidence supports them. Do not invent sensory details.',
  'Prefer direct verbs and specific nouns. Remove generic acclaim, staged openings, borrowed authority and inflated claims of importance.',
  'Vary sentence length and paragraph openings where the meaning benefits; do not impose a rhythm formula.',
  'Avoid stock not-just-X-but-Y contrasts, forced lists of three and conclusions about a timeless legacy.',
  'Keep real contrasts, necessary repetition, quotations, artwork titles and culturally specific terms intact.',
  'Preserve attribution and uncertainty: a rumor, allegation, possibility or interpretation must not become an established fact.',
  'Never invent quotations, first-person experiences, awards, dates, influence or a critic to make the article sound human.',
  'Keep straightforward sentences when they already work. Do not replace ordinary words with ornate synonyms.',
  'Finish on a concrete supported observation; do not add a summary of how significant the artist is.',
].join('\n');

export function editorialFindings(content: string): EditorialFinding[] {
  const findings: EditorialFinding[] = [];
  const checks: Array<[string, 'error' | 'warning', RegExp, string]> = [
    ['ScrapingJunk','error',/\b(?:skip to (?:main )?content|get the app|log in|sign up|add to cart|accept all cookies|join us)\b/i,'Scraped navigation, login or marketplace text remains.'],
    ['ChatResidue','error',/\b(?:as an ai(?: language model)?|i hope this helps|here is (?:the|your) (?:rewritten |revised )?article|would you like me to|let me know if you)\b/i,'Chat or drafting instructions remain in the article.'],
    ['GenericPraise','warning',/\b(?:rich tapestry|testament to|indelible mark|ever-evolving landscape|visionary genius|timeless legacy|profound impact|vibrant tapestry)\b/i,'Replace generic praise with a specific, source-supported observation.'],
    ['StagedOpening','warning',/\b(?:let(?:'s| us) (?:delve|dive|explore)|it is (?:important|worth) (?:to note|noting)|at its core)\b/i,'State the point directly instead of announcing it.'],
    ['StockContrast','warning',/\bnot (?:just|merely|only)\b[^.!?\n]{0,160}\bbut\b/i,'Keep this contrast only if both halves add documented information.'],
  ];
  // Quoted phrasing may belong to an artwork or a source. Style warnings must not rewrite it.
  const unquoted = content.replace(/"[^"\n]+"|“[^”\n]+”/g, '');
  for (const [rule,severity,pattern,message] of checks) {
    if (pattern.test(severity === 'error' ? content : unquoted)) findings.push({rule,severity,message});
  }
  const paragraphs = content.trim().split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length > 4) findings.push({rule:'ParagraphLimit',severity:'error',message:'The article exceeds four paragraphs.'});
  const normalized = paragraphs.map(p=>p.toLowerCase().replace(/\s+/g,' ').trim());
  if (new Set(normalized).size < normalized.length) findings.push({rule:'RepeatedParagraph',severity:'error',message:'An entire paragraph is repeated.'});
  return findings;
}

export function assertEditorialCopy(content: string): void {
  const errors = editorialFindings(content).filter(f=>f.severity==='error');
  if (errors.length) throw new Error(`editorial-copy:${errors.map(f=>f.rule).join(',')}`);
}

/** Cheap locks precede a separate semantic comparison. They do not prove factual accuracy. */
export function rewritePreservationIssues(original: string, rewritten: string, artistName: string): string[] {
  const issues: string[] = [];
  const normalize=(text:string)=>text.normalize('NFC').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
  if (normalize(original).includes(normalize(artistName)) && !normalize(rewritten).includes(normalize(artistName))) issues.push('artist-name-changed');
  const numbers=(text:string)=>new Set(text.match(/\b\d+(?:[.,:/-]\d+)*(?:%|\b)/g) ?? []);
  const before=numbers(original),after=numbers(rewritten);
  if ([...before].some(n=>!after.has(n)) || [...after].some(n=>!before.has(n))) issues.push('numbers-or-dates-changed');
  const quotations=[...original.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)].map(m=>normalize(m[1]||m[2]));
  if (quotations.some(q=>!normalize(rewritten).includes(q))) issues.push('quotation-or-title-changed');
  return issues;
}
