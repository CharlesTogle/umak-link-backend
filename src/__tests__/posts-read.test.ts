import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import postsRoutes from '../routes/posts.js';

function createAwaitableQuery(rows: Array<Record<string, unknown>>) {
  const result = {
    data: rows,
    error: null,
  };

  const query = {
    eq() {
      return query;
    },
    in() {
      return query;
    },
    not() {
      return query;
    },
    order() {
      return query;
    },
    range() {
      return query;
    },
    then(onfulfilled?: (value: typeof result) => unknown, onrejected?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };

  return query;
}

test('GET /posts returns under-investigation posts derived from custody attempts even after office receipt', async () => {
  const app = Fastify();
  let postPublicViewSelectCount = 0;
  let custodyAttemptSelectCount = 0;

  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            postPublicViewSelectCount += 1;

            if (postPublicViewSelectCount === 1) {
              assert.equal(columns, 'post_id');
              return createAwaitableQuery([]);
            }

            if (postPublicViewSelectCount === 2) {
              assert.equal(columns, 'post_id, item_type, custody_status');
              return createAwaitableQuery([
                {
                  post_id: 101,
                  item_type: 'found',
                  custody_status: 'with_guard',
                },
              ]);
            }

            if (postPublicViewSelectCount === 3) {
              assert.equal(columns, '*');
              return createAwaitableQuery([
                {
                  post_id: 101,
                  item_id: 'item-101',
                  poster_name: 'Test User',
                  poster_id: null,
                  item_name: 'Umbrella',
                  item_description: 'Black umbrella',
                  item_type: 'found',
                  item_image_url: 'https://example.com/items/umbrella.webp',
                  category: 'Accessories',
                  last_seen_at: null,
                  last_seen_location: 'North Wing',
                  submission_date: '2026-05-16T04:00:00.000Z',
                  post_status: 'accepted',
                  item_status: 'unclaimed',
                  accepted_by_staff_name: null,
                  accepted_by_staff_email: null,
                  claim_id: null,
                  claimed_by_name: null,
                  claimed_by_email: null,
                  claim_processed_by_staff_id: null,
                  accepted_on_date: null,
                  is_anonymous: false,
                  custody_status: 'with_guard',
                },
              ]);
            }

            throw new Error(`Unexpected post_public_view select call #${postPublicViewSelectCount}`);
          },
        };
      }

      if (table === 'custody_attempt_table') {
        return {
          select(columns: string) {
            custodyAttemptSelectCount += 1;
            assert.equal(columns, 'post_id, attempt_number, office_received_at, investigation_opened_at');

            if (custodyAttemptSelectCount === 1 || custodyAttemptSelectCount === 2) {
              return createAwaitableQuery([
                {
                  post_id: 101,
                  attempt_number: 1,
                  office_received_at: '2026-05-16T03:15:00.000Z',
                  investigation_opened_at: '2026-05-16T03:45:00.000Z',
                },
              ]);
            }

            throw new Error(`Unexpected custody_attempt_table select call #${custodyAttemptSelectCount}`);
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  await app.register(postsRoutes, {
    prefix: '/posts',
    readRouteOptions: {
      getSupabase: () => fakeSupabase,
    },
  });

  const res = await app.inject({
    method: 'GET',
    url: '/posts?custody_status=under_investigation&limit=10',
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    posts: [
      {
        post_id: 101,
        item_id: 'item-101',
        poster_name: 'Test User',
        poster_id: null,
        item_name: 'Umbrella',
        item_description: 'Black umbrella',
        item_type: 'found',
        item_image_url: 'https://example.com/items/umbrella.webp',
        category: 'Accessories',
        last_seen_at: null,
        last_seen_location: 'North Wing',
        submission_date: '2026-05-16T04:00:00.000Z',
        post_status: 'accepted',
        item_status: 'unclaimed',
        accepted_by_staff_name: null,
        accepted_by_staff_email: null,
        claim_id: null,
        claimed_by_name: null,
        claimed_by_email: null,
        claim_processed_by_staff_id: null,
        accepted_on_date: null,
        is_anonymous: false,
        custody_status: 'under_investigation',
      },
    ],
    count: 1,
  });

  await app.close();
});
