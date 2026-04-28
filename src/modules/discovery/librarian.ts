import { getInstitutionCredibility, getInstitutionName, type Config } from '../../config/index.js';

export interface LibrarianAssessment {
  blocked: boolean;
  priority: 'high' | 'medium' | 'low';
  boost: number;
  score: number;
  reason: string;
  domain: string | null;
  institution: string | null;
}

export const DIAMOND_DOMAINS = [
  'enciclopedia.itaucultural.org.br',
  'itaucultural.org.br',
  'mapa.cultura.pe.gov.br',
  'secult.ce.gov.br',
  'museudeartecontemporanea.org.br',
  'museu.gov.br',
  'museus.gov.br',
];

const HIGH_PRIORITY_DOMAINS = [
  ...DIAMOND_DOMAINS,
  'artsandculture.google.com',
  'artforum.com',
  'museudeartesacra.org.br',
  'masp.org.br',
  'pinacoteca.org.br',
  'mam.org.br',
  'museuafrobrasil.org.br',
  'ims.com.br',
  'institutomoreirasalles.org',
  'funarte.gov.br',
  'fundaj.gov.br',
];

const MEDIUM_PRIORITY_DOMAINS = [
  'selecoesarte.com.br',
  'revistacult.uol.com.br',
  'brasildefato.com.br',
  'oglobo.globo.com',
  'g1.globo.com',
  'uol.com.br',
  'premiopipa.com',
  'artebrasileiros.com.br',
  'forumpermanente.org',
];

const BLOCKED_DOMAIN_FRAGMENTS = [
  'pinterest.com',
  'instagram.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'artsy.net',
  'mutualart.com',
  'dailyartfair.com',
  'artstation.com',
  'deviantart.com',
  'behance.net',
  'mercadolivre.com',
  'shopee.com',
  'amazon.',
];

const BLOCKED_PATH_FRAGMENTS = [
  '/shop/',
  '/product/',
  '/products/',
  '/store/',
  '/cart',
  '/checkout',
  '/produto/',
  '/comprar',
  '/buy/',
  '/marketplace/',
];

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function isEduOrGov(domain: string): boolean {
  return (
    domain.endsWith('.edu') ||
    domain.endsWith('.edu.br') ||
    domain.endsWith('.gov') ||
    domain.endsWith('.gov.br')
  );
}

function isAcademicOrg(domain: string): boolean {
  return (
    domain.endsWith('.org') ||
    domain.endsWith('.org.br') ||
    domain.includes('museum') ||
    domain.includes('museu')
  );
}

export function assessSourceWithLibrarian(
  url: string,
  config: Config,
  baseScore = 0
): LibrarianAssessment {
  const domain = safeDomain(url);
  const institution = getInstitutionName(url, config.institutions);

  if (!domain) {
    return {
      blocked: false,
      priority: 'low',
      boost: 0,
      score: baseScore,
      reason: 'invalid-domain',
      domain: null,
      institution,
    };
  }

  const normalizedUrl = url.toLowerCase();

  if (
    BLOCKED_DOMAIN_FRAGMENTS.some((item) => domain === item || domain.endsWith(`.${item}`)) ||
    BLOCKED_PATH_FRAGMENTS.some((item) => normalizedUrl.includes(item))
  ) {
    return {
      blocked: true,
      priority: 'low',
      boost: -99,
      score: -99,
      reason: 'blocked-marketplace-or-social',
      domain,
      institution,
    };
  }

  const institutionalCredibility = getInstitutionCredibility(url, config.institutions);
  let boost = 0;
  let priority: LibrarianAssessment['priority'] = 'low';
  let reason = 'generic';

  if (
    institutionalCredibility >= 0.9 ||
    HIGH_PRIORITY_DOMAINS.some((item) => domain === item || domain.endsWith(`.${item}`)) ||
    isEduOrGov(domain) ||
    isAcademicOrg(domain)
  ) {
    boost = 5;
    priority = 'high';
    reason = 'high-authority-institution';
  } else if (
    MEDIUM_PRIORITY_DOMAINS.some((item) => domain === item || domain.endsWith(`.${item}`)) ||
    domain.endsWith('.com.br')
  ) {
    boost = 2;
    priority = 'medium';
    reason = 'established-editorial-source';
  }

  return {
    blocked: false,
    priority,
    boost,
    score: baseScore + boost,
    reason,
    domain,
    institution,
  };
}

export function isDiamondDomain(url: string): boolean {
  const domain = safeDomain(url);
  if (!domain) {
    return false;
  }

  return DIAMOND_DOMAINS.some((item) => domain === item || domain.endsWith(`.${item}`));
}

export function isLibrarianApproved(
  url: string,
  config: Config,
  minimumPriority: 'medium' | 'low' = 'medium'
): boolean {
  const assessment = assessSourceWithLibrarian(url, config);
  if (assessment.blocked) {
    return false;
  }

  if (minimumPriority === 'low') {
    return true;
  }

  return assessment.priority === 'high' || assessment.priority === 'medium';
}
