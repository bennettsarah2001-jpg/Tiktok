import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TikTokClient, TikTokError, createPkcePair, planChunks } from '../src/index.js';

/** Fake fetch that records calls and replies with queued responses. */
function mockFetch(...responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    const r = responses.shift() ?? { body: {} };
    const status = r.status ?? 200;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const ok = (data) => ({ body: { data, error: { code: 'ok', message: '', log_id: 'x' } } });
const client = (fetch) =>
  new TikTokClient({ clientKey: 'ck', clientSecret: 'cs', redirectUri: 'https://app/cb', fetch });

test('builds an authorization URL with PKCE', () => {
  const url = new URL(
    client().getAuthorizationUrl({ scopes: ['user.info.basic', 'video.list'], state: 's1', codeChallenge: 'ch' }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(url.searchParams.get('client_key'), 'ck');
  assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.list');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app/cb');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 's1');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('PKCE challenge is the base64url SHA-256 of the verifier', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('exchanges a code for tokens', async () => {
  const fetch = mockFetch({ body: { access_token: 'at', refresh_token: 'rt', open_id: 'o' } });
  const tokens = await client(fetch).exchangeCode({ code: 'c', codeVerifier: 'v' });
  assert.equal(tokens.access_token, 'at');
  const [call] = fetch.calls;
  assert.equal(call.url, 'https://open.tiktokapis.com/v2/oauth/token/');
  assert.equal(call.method, 'POST');
  const form = Object.fromEntries(call.body);
  assert.deepEqual(form, {
    client_key: 'ck',
    client_secret: 'cs',
    grant_type: 'authorization_code',
    code: 'c',
    redirect_uri: 'https://app/cb',
    code_verifier: 'v',
  });
});

test('OAuth errors become TikTokError', async () => {
  const fetch = mockFetch({
    body: { error: 'invalid_grant', error_description: 'Authorization code is expired.', log_id: 'L' },
  });
  await assert.rejects(client(fetch).refreshToken('rt'), (err) => {
    assert.ok(err instanceof TikTokError);
    assert.equal(err.code, 'invalid_grant');
    assert.equal(err.logId, 'L');
    assert.equal(err.message, 'Authorization code is expired.');
    return true;
  });
});

test('getUserInfo sends bearer token and fields', async () => {
  const fetch = mockFetch(ok({ user: { open_id: 'o', display_name: 'Sam' } }));
  const user = await client(fetch).getUserInfo('at', ['open_id', 'display_name']);
  assert.equal(user.display_name, 'Sam');
  const [call] = fetch.calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.url, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id%2Cdisplay_name');
  assert.equal(call.headers.Authorization, 'Bearer at');
  assert.equal(call.body, undefined);
});

test('API errors become TikTokError', async () => {
  const fetch = mockFetch({
    status: 401,
    body: { data: {}, error: { code: 'access_token_invalid', message: 'bad token', log_id: 'L2' } },
  });
  await assert.rejects(client(fetch).getUserInfo('at'), { name: 'TikTokError', code: 'access_token_invalid', status: 401 });
});

test('iterateVideos follows the cursor', async () => {
  const fetch = mockFetch(
    ok({ videos: [{ id: '1' }, { id: '2' }], cursor: 123, has_more: true }),
    ok({ videos: [{ id: '3' }], cursor: 456, has_more: false }),
  );
  const ids = [];
  for await (const v of client(fetch).iterateVideos('at', { maxCount: 2 })) ids.push(v.id);
  assert.deepEqual(ids, ['1', '2', '3']);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { max_count: 2 });
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { max_count: 2, cursor: 123 });
});

test('directPostVideo with PULL_FROM_URL', async () => {
  const fetch = mockFetch(ok({ publish_id: 'p1' }));
  const res = await client(fetch).directPostVideo('at', {
    postInfo: { title: 'hi', privacy_level: 'SELF_ONLY' },
    source: { videoUrl: 'https://example.com/v.mp4' },
  });
  assert.equal(res.publish_id, 'p1');
  assert.equal(fetch.calls[0].url, 'https://open.tiktokapis.com/v2/post/publish/video/init/');
  assert.deepEqual(JSON.parse(fetch.calls[0].body), {
    post_info: { title: 'hi', privacy_level: 'SELF_ONLY' },
    source_info: { source: 'PULL_FROM_URL', video_url: 'https://example.com/v.mp4' },
  });
});

test('uploadVideoDraft with FILE_UPLOAD computes chunks', async () => {
  const fetch = mockFetch(ok({ publish_id: 'p2', upload_url: 'https://up' }));
  const size = 25 * 1024 * 1024;
  await client(fetch).uploadVideoDraft('at', { source: { videoSize: size } });
  assert.deepEqual(JSON.parse(fetch.calls[0].body).source_info, {
    source: 'FILE_UPLOAD',
    video_size: size,
    chunk_size: 10 * 1024 * 1024,
    total_chunk_count: 2,
  });
});

test('planChunks', () => {
  assert.deepEqual(planChunks(1000), { chunkSize: 1000, totalChunkCount: 1 });
  assert.deepEqual(planChunks(25 * 1024 * 1024), { chunkSize: 10 * 1024 * 1024, totalChunkCount: 2 });
});

test('uploadVideo sends chunks with Content-Range, remainder in the last chunk', async () => {
  const fetch = mockFetch({ status: 206, body: '' }, { status: 201, body: '' });
  const video = Buffer.alloc(25);
  await client(fetch).uploadVideo('https://up', video, { chunkSize: 10 });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].headers['Content-Range'], 'bytes 0-9/25');
  assert.equal(fetch.calls[1].headers['Content-Range'], 'bytes 10-24/25');
  assert.equal(fetch.calls[1].body.length, 15);
});
