import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import logger from '../utils/logger.js';

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
      const result = await this.model.generateContent(prompt);
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
