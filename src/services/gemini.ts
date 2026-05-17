import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import logger from '../utils/logger.js';
import { buildSearchQueryFromAttributes } from '../utils/search-metadata.js';
import { GENERAL_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

const CREATE_POST_CATEGORIES = [
  'Electronics',
  'Accessories',
  'Documents',
  'Books & Notebooks',
  'Bags',
  'Wallets & Cards',
  'Keys',
  'Clothing',
  'Eyewear',
  'School Supplies',
  'Sports Equipment',
  'Water Bottles',
  'Umbrellas',
  'Medical Items',
  'Other',
] as const;

const GEMINI_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const GEMINI_RATE_LIMIT_MAX_REQUESTS = 10;
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

function normalizeGeminiModelName(modelName: string): string {
  return modelName.replace(/^models\//, '');
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const normalized = normalizeOptionalString(value);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .flatMap((entry) => {
          const normalized = normalizeOptionalString(entry);
          return normalized ? [normalized] : [];
        })
        .filter((entry) => entry.length > 0)
    )
  );
}

function mergeUniqueTerms(...values: Array<string | null | undefined | string[]>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of values) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const normalized = normalizeOptionalString(entry);
      if (!normalized) continue;
      const lowered = normalized.toLowerCase();
      if (seen.has(lowered)) continue;
      seen.add(lowered);
      merged.push(normalized);
    }
  }

  return merged;
}

class GeminiService {
  private client: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;
  private requestTimestamps: number[] = [];
  private retryQueue: Array<{ item: ItemData; retryCount: number }> = [];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      const modelName = normalizeGeminiModelName(
        process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
      );
      this.client = new GoogleGenerativeAI(apiKey);
      this.model = this.client.getGenerativeModel({ model: modelName });
      logger.info({ model: modelName }, 'Gemini service initialized');
    } else {
      logger.warn('GEMINI_API_KEY not configured - AI features disabled');
    }
  }

  private pruneRequestTimestamps(now: number): void {
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < GEMINI_RATE_LIMIT_WINDOW_MS
    );
  }

  private canStartRequest(now: number): boolean {
    this.pruneRequestTimestamps(now);
    return this.requestTimestamps.length < GEMINI_RATE_LIMIT_MAX_REQUESTS;
  }

  private recordRequest(now: number): void {
    this.requestTimestamps.push(now);
    this.pruneRequestTimestamps(now);
  }

  private async acquireRequestSlot(): Promise<boolean> {
    const now = Date.now();
    if (this.canStartRequest(now)) {
      this.recordRequest(now);
      return true;
    }

    return false;
  }

  async generateMetadata(item: ItemData): Promise<Metadata> {
    if (!this.model) {
      throw new Error('Gemini service not configured');
    }

    const canProceed = await this.acquireRequestSlot();
    if (!canProceed) {
      throw new RateLimitError('Rate limit exceeded');
    }

    try {
      const prompt = this.buildPrompt(item);
      const result = await withTimeout(
        this.model.generateContent(prompt),
        GENERAL_TIMEOUT_MS,
        'Gemini generateContent'
      );
      const response = result.response;
      const text = response.text();

      return this.parseResponse(text);
    } catch (error) {
      if (error instanceof Error && error.message.includes('429')) {
        await this.queueForRetry(item);
        throw new RateLimitError('Gemini rate limit exceeded');
      }
      throw error;
    }
  }

  async generateCreatePostAutofill(
    input: CreatePostAutofillInput
  ): Promise<CreatePostAutofillOutput> {
    if (!this.model) {
      throw new Error('Gemini service not configured');
    }

    const canProceed = await this.acquireRequestSlot();
    if (!canProceed) {
      throw new RateLimitError('Rate limit exceeded');
    }

    const prompt = this.buildCreatePostAutofillPrompt(input);

    logger.info(
      { mimeType: input.mimeType, imageSize: input.imageBase64.length },
      'Sending create-post autofill request to Gemini'
    );

    let result;
    try {
      result = await withTimeout(
        this.model.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType: input.mimeType,
              data: input.imageBase64,
            },
          },
        ]),
        GENERAL_TIMEOUT_MS,
        'Gemini create-post autofill'
      );
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      logger.error(
        {
          status: errObj?.status ?? errObj?.['statusCode'],
          statusText: errObj?.statusText,
          message: errObj?.message,
          errorDetails: errObj?.errorDetails,
        },
        'Gemini API call failed for create-post autofill'
      );
      throw error;
    }

    const responseText = result.response.text();
    logger.info(
      { responseLength: responseText.length },
      'Gemini create-post autofill response received'
    );
    return this.parseCreatePostAutofillResponse(responseText);
  }

  async generateReverseImageSearchQuery(input: ReverseImageSearchInput): Promise<string> {
    if (!this.model) {
      throw new Error('Gemini service not configured');
    }

    const canProceed = await this.acquireRequestSlot();
    if (!canProceed) {
      throw new RateLimitError('Rate limit exceeded');
    }

    const prompt = `Analyze this image of a lost or found item and extract only objective, visually grounded search attributes.

Rules:
- Infer only what is directly visible or strongly implied by the image.
- Do not invent ownership, use case, or hidden details.
- Return valid JSON only. No markdown. No explanation.
- Keep terms short and practical for lost-and-found search.
- Use empty arrays when an attribute is not visible.

Respond with:
{
  "caption": "short literal description",
  "main_objects": ["primary object"],
  "synonyms": ["alternative object name"],
  "descriptive_words": ["color", "material", "fixed feature"],
  "potential_brands": ["brand if visible or strongly implied"],
  "visible_text": ["readable text on the item"]
}`;

    const result = await withTimeout(
      this.model.generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: input.mimeType,
            data: input.imageBase64,
          },
        },
      ]),
      GENERAL_TIMEOUT_MS,
      'Gemini reverse-image search'
    );

    const attributes = this.parseReverseImageSearchAttributes(result.response.text());
    return buildSearchQueryFromAttributes({
      searchValue: input.searchValue,
      caption: attributes.caption,
      mainObjects: attributes.main_objects,
      synonyms: attributes.synonyms,
      descriptiveWords: attributes.descriptive_words,
      potentialBrands: attributes.potential_brands,
      visibleText: attributes.visible_text,
    });
  }

  private buildPrompt(item: ItemData): string {
    return `Analyze this lost/found item and generate metadata for search matching.

Item Name: ${item.name}
Description: ${item.description || 'No description provided'}
Category: ${item.category || 'Unknown'}
Type: ${item.type}

Generate the following:
1. Keywords (5-10 relevant search terms)
2. Color (primary color if discernible)
3. Brand (if mentioned or identifiable)
4. Condition (good/fair/poor/unknown)
5. Estimated value range (low/medium/high/unknown)
6. Caption (short literal description of the item)
7. Main objects (1-3 core object labels)
8. Synonyms (0-5 alternative search words)
9. Descriptive words (2-6 visible physical descriptors)
10. Potential brands (0-3 likely or mentioned brands)

Respond in JSON format:
{
  "keywords": ["keyword1", "keyword2"],
  "color": "color or null",
  "brand": "brand or null",
  "condition": "condition",
  "value_range": "range",
  "caption": "short caption or null",
  "main_objects": ["object1"],
  "synonyms": ["synonym1"],
  "descriptive_words": ["descriptor1"],
  "potential_brands": ["brand1"]
}`;
  }

  private buildCreatePostAutofillPrompt(input: CreatePostAutofillInput): string {
    const titleSeed = input.currentTitle?.trim() || '';
    const descriptionSeed = input.currentDescription?.trim() || '';
    const categorySeed = input.currentCategory?.trim() || '';
    const categories = CREATE_POST_CATEGORIES.join(', ');

    return `You are helping a university lost-and-found staff create a post from an uploaded item photo.

Rules:
- Infer only what is reasonably visible from the image.
- Return valid JSON only. No markdown. No explanation.
- Output keys: itemName, itemDescription, itemCategory
- itemName: max 32 characters, concise, title-style
- itemDescription: max 150 characters, practical and neutral
- itemCategory: choose exactly one from this list:
${categories}
- If uncertain about category, use "Other".

Current staff inputs (may be empty and can be improved):
- itemName: "${titleSeed}"
- itemDescription: "${descriptionSeed}"
- itemCategory: "${categorySeed}"

Respond with:
{
  "itemName": "string",
  "itemDescription": "string",
  "itemCategory": "string"
}`;
  }

  private parseResponse(text: string): Metadata {
    try {
      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const keywords = normalizeStringArray(parsed.keywords);
      const color = normalizeOptionalString(parsed.color);
      const brand = normalizeOptionalString(parsed.brand);
      const caption = normalizeOptionalString(parsed.caption);
      const mainObjects = normalizeStringArray(parsed.main_objects);
      const synonyms = normalizeStringArray(parsed.synonyms);
      const descriptiveWords = normalizeStringArray(parsed.descriptive_words);
      const potentialBrands = mergeUniqueTerms(
        normalizeStringArray(parsed.potential_brands),
        brand
      );

      return {
        keywords,
        color,
        brand,
        condition: normalizeOptionalString(parsed.condition) || 'unknown',
        value_range: normalizeOptionalString(parsed.value_range) || 'unknown',
        caption,
        main_objects: mainObjects,
        synonyms,
        descriptive_words: descriptiveWords,
        potential_brands: potentialBrands,
      };
    } catch {
      logger.error({ text }, 'Failed to parse Gemini response');
      return {
        keywords: [],
        color: null,
        brand: null,
        condition: 'unknown',
        value_range: 'unknown',
        caption: null,
        main_objects: [],
        synonyms: [],
        descriptive_words: [],
        potential_brands: [],
      };
    }
  }

  private parseReverseImageSearchAttributes(text: string): ReverseImageSearchAttributes {
    try {
      const raw = text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in reverse image response');
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        caption: normalizeOptionalString(parsed.caption),
        main_objects: normalizeStringArray(parsed.main_objects),
        synonyms: normalizeStringArray(parsed.synonyms),
        descriptive_words: normalizeStringArray(parsed.descriptive_words),
        potential_brands: normalizeStringArray(parsed.potential_brands),
        visible_text: normalizeStringArray(parsed.visible_text),
      };
    } catch {
      logger.error({ text }, 'Failed to parse Gemini reverse image attributes');
      return {
        caption: null,
        main_objects: [],
        synonyms: [],
        descriptive_words: [],
        potential_brands: [],
        visible_text: [],
      };
    }
  }

  private parseCreatePostAutofillResponse(text: string): CreatePostAutofillOutput {
    const raw = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse Gemini autofill response');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      throw new Error('Invalid Gemini autofill JSON');
    }

    const itemName =
      typeof parsed.itemName === 'string' ? parsed.itemName.trim().slice(0, 32) : '';
    const itemDescription =
      typeof parsed.itemDescription === 'string'
        ? parsed.itemDescription.trim().slice(0, 150)
        : '';
    const candidateCategory =
      typeof parsed.itemCategory === 'string' ? parsed.itemCategory.trim() : 'Other';

    const allowedCategories = new Set<string>(CREATE_POST_CATEGORIES);
    const itemCategory = allowedCategories.has(candidateCategory)
      ? candidateCategory
      : 'Other';

    return {
      itemName: itemName || undefined,
      itemDescription: itemDescription || undefined,
      itemCategory,
    };
  }

  private async queueForRetry(item: ItemData): Promise<void> {
    this.retryQueue.push({ item, retryCount: 0 });
    logger.info({ itemId: item.id }, 'Item queued for retry');
  }

  getRetryQueue(): Array<{ item: ItemData; retryCount: number }> {
    return [...this.retryQueue];
  }

  clearRetryQueue(): void {
    this.retryQueue = [];
  }

  async processRetryQueue(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const maxRetries = 3;

    const queue = [...this.retryQueue];
    this.retryQueue = [];

    for (const entry of queue) {
      if (entry.retryCount >= maxRetries) {
        failed++;
        logger.warn({ itemId: entry.item.id }, 'Max retries exceeded for item');
        continue;
      }

      try {
        await this.generateMetadata(entry.item);
        processed++;
      } catch {
        entry.retryCount++;
        this.retryQueue.push(entry);
        failed++;
      }
    }

    return { processed, failed };
  }
}

export interface ItemData {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: 'found' | 'lost' | 'missing';
}

export interface Metadata {
  keywords: string[];
  color: string | null;
  brand: string | null;
  condition: string;
  value_range: string;
  caption?: string | null;
  main_objects?: string[];
  synonyms?: string[];
  descriptive_words?: string[];
  potential_brands?: string[];
}

export interface CreatePostAutofillInput {
  imageBase64: string;
  mimeType: string;
  currentTitle?: string;
  currentDescription?: string;
  currentCategory?: string;
}

export interface CreatePostAutofillOutput {
  itemName?: string;
  itemDescription?: string;
  itemCategory?: string;
}

export interface ReverseImageSearchInput {
  imageBase64: string;
  mimeType: string;
  searchValue?: string;
}

interface ReverseImageSearchAttributes {
  caption: string | null;
  main_objects: string[];
  synonyms: string[];
  descriptive_words: string[];
  potential_brands: string[];
  visible_text: string[];
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// Singleton instance
let geminiService: GeminiService | null = null;

export function getGeminiService(): GeminiService {
  if (!geminiService) {
    geminiService = new GeminiService();
  }
  return geminiService;
}

export default getGeminiService;
