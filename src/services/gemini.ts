import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import logger from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

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

interface RateLimiter {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number;
}

class GeminiService {
  private client: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;
  private rateLimiter: RateLimiter = {
    tokens: 10,
    lastRefill: Date.now(),
    maxTokens: 10,
    refillRate: 60000, // 1 token per minute
  };
  private retryQueue: Array<{ item: ItemData; retryCount: number }> = [];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
      this.model = this.client.getGenerativeModel({ model: 'gemini-1.5-flash' });
      logger.info('Gemini service initialized');
    } else {
      logger.warn('GEMINI_API_KEY not configured - AI features disabled');
    }
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.rateLimiter.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.rateLimiter.refillRate);

    if (tokensToAdd > 0) {
      this.rateLimiter.tokens = Math.min(
        this.rateLimiter.maxTokens,
        this.rateLimiter.tokens + tokensToAdd
      );
      this.rateLimiter.lastRefill = now;
    }
  }

  private async acquireToken(): Promise<boolean> {
    this.refillTokens();

    if (this.rateLimiter.tokens > 0) {
      this.rateLimiter.tokens--;
      return true;
    }

    return false;
  }

  async generateMetadata(item: ItemData): Promise<Metadata> {
    if (!this.model) {
      throw new Error('Gemini service not configured');
    }

    const canProceed = await this.acquireToken();
    if (!canProceed) {
      throw new RateLimitError('Rate limit exceeded');
    }

    try {
      const prompt = this.buildPrompt(item);
      const result = await withTimeout(
        this.model.generateContent(prompt),
        DEFAULT_TIMEOUT_MS,
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

    const canProceed = await this.acquireToken();
    if (!canProceed) {
      throw new RateLimitError('Rate limit exceeded');
    }

    const prompt = this.buildCreatePostAutofillPrompt(input);
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
      DEFAULT_TIMEOUT_MS,
      'Gemini create-post autofill'
    );

    const responseText = result.response.text();
    return this.parseCreatePostAutofillResponse(responseText);
  }

  async generateReverseImageSearchQuery(input: ReverseImageSearchInput): Promise<string> {
    if (!this.model) {
      throw new Error('Gemini service not configured');
    }

    const canProceed = await this.acquireToken();
    if (!canProceed) {
      throw new RateLimitError('Rate limit exceeded');
    }

    const prompt = `Analyze this image of a lost or found item. Identify the main object, its color, brand, model, material, and fixed physical features visible in the image.

Generate a search query string using only objective attributes.
- Use AND to pair adjectives and nouns.
- Use OR for alternatives in the same attribute category.
- Output 10 to 20 keyword phrases.
- Output only the final query string without explanations or markdown.`;

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
      DEFAULT_TIMEOUT_MS,
      'Gemini reverse-image search'
    );

    const rawQuery = result.response
      .text()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/['"]/g, '')
      .trim();

    const baseQuery = input.searchValue?.trim() || '';
    if (baseQuery && rawQuery) {
      return `${baseQuery} OR ${rawQuery}`;
    }
    if (rawQuery) {
      return rawQuery;
    }
    return baseQuery;
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

Respond in JSON format:
{
  "keywords": ["keyword1", "keyword2"],
  "color": "color or null",
  "brand": "brand or null",
  "condition": "condition",
  "value_range": "range"
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

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        keywords: parsed.keywords || [],
        color: parsed.color || null,
        brand: parsed.brand || null,
        condition: parsed.condition || 'unknown',
        value_range: parsed.value_range || 'unknown',
      };
    } catch {
      logger.error({ text }, 'Failed to parse Gemini response');
      return {
        keywords: [],
        color: null,
        brand: null,
        condition: 'unknown',
        value_range: 'unknown',
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
