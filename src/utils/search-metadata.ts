interface SearchQuerySource {
  itemName?: unknown;
  itemDescription?: unknown;
  category?: unknown;
  itemMetadata?: unknown;
  searchValue?: unknown;
}

export interface SearchQueryAttributes {
  searchValue?: unknown;
  itemName?: unknown;
  itemDescription?: unknown;
  category?: unknown;
  caption?: unknown;
  mainObjects?: unknown;
  synonyms?: unknown;
  descriptiveWords?: unknown;
  potentialBrands?: unknown;
  keywords?: unknown;
  color?: unknown;
  brand?: unknown;
  visibleText?: unknown;
}

export interface BlendedSearchMetadata {
  caption: string | null;
  mainObjects: string[];
  synonyms: string[];
  descriptiveWords: string[];
  potentialBrands: string[];
  keywords: string[];
  color: string | null;
  brand: string | null;
  visibleText: string[];
}

const MAX_OBJECT_TERMS = 5;
const MAX_STRONG_SUPPORTING_TERMS = 4;
const MAX_WEAK_SUPPORTING_TERMS = 6;
const MAX_QUERY_VARIANTS = 16;

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = toNonEmptyString(value);
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) return [];

  return value
    .flatMap((entry) => {
      const normalized = toNonEmptyString(entry);
      return normalized ? [normalized] : [];
    })
    .filter((entry) => entry.length > 0);
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeTerms(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const trimmed = toNonEmptyString(value);
    if (!trimmed) continue;

    const normalized = normalizeTerm(trimmed);
    if (normalized.length === 0 || seen.has(normalized)) continue;

    seen.add(normalized);
    results.push(trimmed);
  }

  return results;
}

function sanitizeQueryTerm(value: string): string | null {
  const collapsed = value
    .replace(/["“”]+/g, '')
    .replace(/[()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return collapsed.length > 0 ? collapsed : null;
}

function formatQueryTerm(value: string): string | null {
  const sanitized = sanitizeQueryTerm(value);
  if (!sanitized) return null;
  if (sanitized.includes(' ')) {
    return `"${sanitized}"`;
  }
  return sanitized;
}

function formatBaseSearchValue(value: unknown): string | null {
  const normalized = toNonEmptyString(value);
  return normalized ? sanitizeQueryTerm(normalized) : null;
}

function toShortPhraseCandidate(value: unknown): string | null {
  const text = toNonEmptyString(value);
  if (!text) return null;

  const words = text.split(/\s+/);
  if (words.length > 12 || text.length > 90) {
    return null;
  }

  return text;
}

function combineSupportingWithAnchors(
  supportingTerms: string[],
  anchors: string[],
  limit: number
): string[] {
  const phrases: string[] = [];

  for (const supportingTerm of supportingTerms) {
    for (const anchor of anchors) {
      if (normalizeTerm(supportingTerm) === normalizeTerm(anchor)) continue;
      phrases.push(`${supportingTerm} ${anchor}`);

      if (phrases.length >= limit) {
        return dedupeTerms(phrases);
      }
    }
  }

  return dedupeTerms(phrases);
}

export function readBlendedSearchMetadata(value: unknown): BlendedSearchMetadata {
  const metadata =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  return {
    caption: toNonEmptyString(metadata.caption),
    mainObjects: dedupeTerms(toStringArray(metadata.main_objects)),
    synonyms: dedupeTerms(toStringArray(metadata.synonyms)),
    descriptiveWords: dedupeTerms(toStringArray(metadata.descriptive_words)),
    potentialBrands: dedupeTerms(toStringArray(metadata.potential_brands)),
    keywords: dedupeTerms(toStringArray(metadata.keywords)),
    color: toNonEmptyString(metadata.color),
    brand: toNonEmptyString(metadata.brand),
    visibleText: dedupeTerms(toStringArray(metadata.visible_text)),
  };
}

export function buildSearchQueryFromAttributes(attributes: SearchQueryAttributes): string {
  const rawBaseSearchValue = formatBaseSearchValue(attributes.searchValue);
  const itemName = toNonEmptyString(attributes.itemName);
  const shortDescription = toShortPhraseCandidate(attributes.itemDescription);
  const caption = toNonEmptyString(attributes.caption);

  const objectTerms = dedupeTerms([
    ...toStringArray(attributes.mainObjects),
    ...toStringArray(attributes.synonyms),
    itemName,
    caption,
  ]).slice(0, MAX_OBJECT_TERMS);

  const anchors = objectTerms.length > 0 ? objectTerms.slice(0, 3) : dedupeTerms([itemName, caption]);

  const strongSupportingTerms = dedupeTerms([
    toNonEmptyString(attributes.brand),
    ...toStringArray(attributes.potentialBrands),
    ...toStringArray(attributes.visibleText),
  ]).slice(0, MAX_STRONG_SUPPORTING_TERMS);

  const weakSupportingTerms = dedupeTerms([
    toNonEmptyString(attributes.color),
    ...toStringArray(attributes.descriptiveWords),
    ...toStringArray(attributes.keywords),
  ]).slice(0, MAX_WEAK_SUPPORTING_TERMS);

  const exactCandidates = dedupeTerms([itemName, caption, shortDescription]);
  const strongCompoundCandidates = combineSupportingWithAnchors(
    strongSupportingTerms,
    anchors,
    6
  );
  const weakCompoundCandidates = combineSupportingWithAnchors(weakSupportingTerms, anchors, 8);

  const formattedVariants = dedupeTerms([
    ...exactCandidates,
    ...objectTerms,
    ...strongCompoundCandidates,
    ...weakCompoundCandidates,
  ])
    .slice(0, MAX_QUERY_VARIANTS)
    .map(formatQueryTerm)
    .filter((term): term is string => Boolean(term));

  if (rawBaseSearchValue) {
    const normalizedBase = normalizeTerm(rawBaseSearchValue);
    const filteredVariants = formattedVariants.filter(
      (term) => normalizeTerm(term.replace(/^"|"$/g, '')) !== normalizedBase
    );
    return [rawBaseSearchValue, ...filteredVariants].join(' OR ');
  }

  return formattedVariants.join(' OR ');
}

export function buildSearchQueryFromSource(source: SearchQuerySource): string {
  const metadata = readBlendedSearchMetadata(source.itemMetadata);

  return buildSearchQueryFromAttributes({
    searchValue: source.searchValue,
    itemName: source.itemName,
    itemDescription: source.itemDescription,
    category: source.category,
    caption: metadata.caption,
    mainObjects: metadata.mainObjects,
    synonyms: metadata.synonyms,
    descriptiveWords: metadata.descriptiveWords,
    potentialBrands: metadata.potentialBrands,
    keywords: metadata.keywords,
    color: metadata.color,
    brand: metadata.brand,
    visibleText: metadata.visibleText,
  });
}
