import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQueryFromAttributes,
  buildSearchQueryFromSource,
  readBlendedSearchMetadata,
} from './search-metadata.js';

test('readBlendedSearchMetadata normalizes legacy and structured metadata fields', () => {
  const metadata = readBlendedSearchMetadata({
    caption: ' Black wallet ',
    main_objects: ['wallet', 'wallet', ' billfold '],
    synonyms: ['billfold', 'purse'],
    descriptive_words: ['black', ' leather '],
    potential_brands: ['nike', 'Nike'],
    keywords: ['wallet', 'zipper'],
    color: ' black ',
    brand: ' Nike ',
    visible_text: ['UMak ID'],
  });

  assert.deepEqual(metadata, {
    caption: 'Black wallet',
    mainObjects: ['wallet', 'billfold'],
    synonyms: ['billfold', 'purse'],
    descriptiveWords: ['black', 'leather'],
    potentialBrands: ['nike'],
    keywords: ['wallet', 'zipper'],
    color: 'black',
    brand: 'Nike',
    visibleText: ['UMak ID'],
  });
});

test('buildSearchQueryFromSource keeps object terms primary and compounds weak terms with anchors', () => {
  const query = buildSearchQueryFromSource({
    itemName: 'Wallet',
    itemMetadata: {
      main_objects: ['wallet'],
      synonyms: ['billfold'],
      descriptive_words: ['black', 'leather'],
      potential_brands: ['Nike'],
      color: 'black',
      keywords: ['zipper'],
    },
  });

  assert.match(query, /\bWallet\b/);
  assert.match(query, /\bbillfold\b/);
  assert.match(query, /"Nike wallet"/);
  assert.match(query, /"black wallet"/);
  assert.match(query, /"leather wallet"/);
  assert.match(query, /"zipper wallet"/);
  assert.doesNotMatch(query, /(^| OR )black( OR |$)/);
  assert.doesNotMatch(query, /(^| OR )Nike( OR |$)/);
});

test('buildSearchQueryFromAttributes preserves the user search seed and adds structured variants', () => {
  const query = buildSearchQueryFromAttributes({
    searchValue: 'pedestal fan',
    caption: 'silver pedestal fan',
    mainObjects: ['fan'],
    descriptiveWords: ['metal', 'round base'],
    potentialBrands: ['Union'],
    visibleText: ['Turbo'],
  });

  assert.match(query, /^pedestal fan OR /);
  assert.match(query, /"silver pedestal fan"/);
  assert.match(query, /(^| OR )fan( OR |$)/);
  assert.match(query, /"Union fan"/);
  assert.match(query, /"Turbo fan"/);
  assert.match(query, /"metal fan"/);
  assert.match(query, /"round base fan"/);
});

test('buildSearchQueryFromSource returns an empty query when no searchable values are present', () => {
  assert.equal(buildSearchQueryFromSource({}), '');
});
