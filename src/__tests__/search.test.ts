import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const geminiModuleSource = [
  "export class RateLimitError extends Error {",
  "  constructor(message) {",
  "    super(message);",
  "    this.name = 'RateLimitError';",
  '  }',
  '}',
  'export function getGeminiService() {',
  '  return globalThis.__testGeminiService;',
  '}',
  'export default getGeminiService;',
].join('\n');

interface TestGeminiService {
  generateReverseImageSearchQuery(input: {
    imageBase64: string;
    mimeType: string;
    searchValue?: string;
  }): Promise<string>;
}

async function runImageQueryHarness(): Promise<{
  statusCode: number;
  body: { success: boolean; search_query: string };
  capturedInput: {
    imageBase64: string;
    mimeType: string;
    searchValue?: string;
  } | null;
}> {
  process.env.JWT_SECRET = 'test_secret_for_tests';

  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.includes('/src/services/gemini.')) {
        return {
          format: 'module',
          shortCircuit: true,
          source: geminiModuleSource,
        };
      }

      return nextLoad(url, context);
    },
  });

  try {
    const [{ default: Fastify }, { default: jwt }, { default: searchRoutes }, { errorHandler }] =
      await Promise.all([
        import('fastify'),
        import('jsonwebtoken'),
        import('../routes/search.js'),
        import('../middleware/error-handler.js'),
      ]);

    let capturedInput = null as {
      imageBase64: string;
      mimeType: string;
      searchValue?: string;
    } | null;

    const testGlobals = globalThis as typeof globalThis & {
      __testGeminiService?: TestGeminiService;
    };

    testGlobals.__testGeminiService = {
      async generateReverseImageSearchQuery(input: {
        imageBase64: string;
        mimeType: string;
        searchValue?: string;
      }) {
        capturedInput = input;
        return input.searchValue ? input.searchValue + ' fan' : 'fan';
      },
    };

    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(searchRoutes, { prefix: '/search' });

    const token = jwt.sign(
      {
        user_id: 'user-1',
        email: 'user-1@umak.edu.ph',
        user_type: 'User',
      },
      process.env.JWT_SECRET,
      { algorithm: 'HS256' }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/search/image-query',
      headers: {
        authorization: 'Bearer ' + token,
      },
      payload: {
        image_data_url: 'data:image/png;base64,QUJDRA==',
        search_value: 'desk lamp',
      },
    });

    await app.close();

    return {
      statusCode: res.statusCode,
      body: JSON.parse(res.body) as { success: boolean; search_query: string },
      capturedInput,
    };
  } finally {
    hooks.deregister();
    delete (globalThis as { __testGeminiService?: TestGeminiService }).__testGeminiService;
  }
}

test(
  'POST /search/image-query allows authenticated users past the role gate and keeps the API shape stable',
  { concurrency: false },
  async () => {
    const result = await runImageQueryHarness();

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      success: true,
      search_query: 'desk lamp fan',
    });
    assert.deepEqual(result.capturedInput, {
      imageBase64: 'QUJDRA==',
      mimeType: 'image/png',
      searchValue: 'desk lamp',
    });
  }
);
