import { createHash, randomBytes } from 'node:crypto';

export const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const API_BASE = 'https://open.tiktokapis.com';

export const DEFAULT_USER_FIELDS = ['open_id', 'union_id', 'avatar_url', 'display_name'];
export const DEFAULT_VIDEO_FIELDS = [
  'id',
  'title',
  'video_description',
  'cover_image_url',
  'share_url',
  'embed_link',
  'duration',
  'create_time',
];

/** Error raised for any non-"ok" response from the TikTok API. */
export class TikTokError extends Error {
  constructor(message, { code, logId, status, body } = {}) {
    super(message);
    this.name = 'TikTokError';
    this.code = code;
    this.logId = logId;
    this.status = status;
    this.body = body;
  }
}

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Random opaque value for the OAuth `state` parameter (CSRF protection). */
export function createState() {
  return base64url(randomBytes(24));
}

/**
 * PKCE verifier/challenge pair. TikTok requires PKCE for desktop and mobile
 * apps; it is optional (but harmless) for web apps.
 */
export function createPkcePair() {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export class TikTokClient {
  /**
   * @param {object} opts
   * @param {string} opts.clientKey     App client key
   * @param {string} [opts.clientSecret] App client secret (required for token calls)
   * @param {string} [opts.redirectUri] Registered redirect URI
   * @param {typeof fetch} [opts.fetch] Custom fetch implementation (for tests)
   */
  constructor({ clientKey, clientSecret, redirectUri, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!clientKey) throw new Error('clientKey is required');
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.fetch = fetchImpl;
  }

  // ---------------------------------------------------------------------------
  // Login Kit (OAuth 2.0)
  // ---------------------------------------------------------------------------

  /** Build the URL to send the user to for authorization. */
  getAuthorizationUrl({ scopes = ['user.info.basic'], state, codeChallenge, redirectUri } = {}) {
    if (!state) throw new Error('state is required');
    const params = new URLSearchParams({
      client_key: this.clientKey,
      response_type: 'code',
      scope: scopes.join(','),
      redirect_uri: redirectUri ?? this.redirectUri,
      state,
    });
    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return `${AUTH_URL}?${params}`;
  }

  /** Exchange an authorization code for access/refresh tokens. */
  exchangeCode({ code, codeVerifier, redirectUri } = {}) {
    if (!code) throw new Error('code is required');
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri ?? this.redirectUri,
    };
    if (codeVerifier) form.code_verifier = codeVerifier;
    return this.#tokenRequest('/v2/oauth/token/', form);
  }

  /** Get a fresh access token using a refresh token. */
  refreshToken(refreshToken) {
    if (!refreshToken) throw new Error('refreshToken is required');
    return this.#tokenRequest('/v2/oauth/token/', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  /** App-level token for endpoints that don't act on behalf of a user. */
  getClientToken() {
    return this.#tokenRequest('/v2/oauth/token/', { grant_type: 'client_credentials' });
  }

  /** Revoke a user's access token (e.g. on logout / disconnect). */
  revokeToken(accessToken) {
    if (!accessToken) throw new Error('accessToken is required');
    return this.#tokenRequest('/v2/oauth/revoke/', { token: accessToken });
  }

  // ---------------------------------------------------------------------------
  // Display API
  // ---------------------------------------------------------------------------

  /** Scope: user.info.basic (+ user.info.profile / user.info.stats for more fields). */
  async getUserInfo(accessToken, fields = DEFAULT_USER_FIELDS) {
    const data = await this.#apiRequest('GET', '/v2/user/info/', accessToken, { fields });
    return data.user;
  }

  /** Scope: video.list. Returns `{ videos, cursor, has_more }`. */
  listVideos(accessToken, { cursor, maxCount = 20, fields = DEFAULT_VIDEO_FIELDS } = {}) {
    const body = { max_count: maxCount };
    if (cursor !== undefined) body.cursor = cursor;
    return this.#apiRequest('POST', '/v2/video/list/', accessToken, { fields, body });
  }

  /** Iterate over every video of the authorized user, following pagination. */
  async *iterateVideos(accessToken, opts = {}) {
    let cursor = opts.cursor;
    for (;;) {
      const page = await this.listVideos(accessToken, { ...opts, cursor });
      yield* page.videos ?? [];
      if (!page.has_more) return;
      cursor = page.cursor;
    }
  }

  /** Scope: video.list. Look up specific videos (max 20 ids) owned by the user. */
  async queryVideos(accessToken, videoIds, fields = DEFAULT_VIDEO_FIELDS) {
    const data = await this.#apiRequest('POST', '/v2/video/query/', accessToken, {
      fields,
      body: { filters: { video_ids: videoIds } },
    });
    return data.videos ?? [];
  }

  // ---------------------------------------------------------------------------
  // Content Posting API
  // ---------------------------------------------------------------------------

  /** Scope: video.publish. Required before a direct post to show privacy options etc. */
  queryCreatorInfo(accessToken) {
    return this.#apiRequest('POST', '/v2/post/publish/creator_info/query/', accessToken, {
      body: {},
    });
  }

  /**
   * Scope: video.publish. Directly post a video to the user's profile.
   *
   * @param {object} postInfo  e.g. `{ title, privacy_level, disable_comment, ... }`.
   *                           `privacy_level` must be one returned by queryCreatorInfo.
   * @param {object} source    `{ videoUrl }` to have TikTok pull from a verified
   *                           domain, or `{ videoSize, chunkSize?, totalChunkCount? }`
   *                           to upload the file yourself via uploadVideo().
   * @returns `{ publish_id, upload_url? }`
   */
  directPostVideo(accessToken, { postInfo, source }) {
    return this.#apiRequest('POST', '/v2/post/publish/video/init/', accessToken, {
      body: { post_info: postInfo, source_info: buildSourceInfo(source) },
    });
  }

  /**
   * Scope: video.upload. Send a video to the user's TikTok inbox as a draft,
   * which they finish editing and post from within the app.
   */
  uploadVideoDraft(accessToken, { source }) {
    return this.#apiRequest('POST', '/v2/post/publish/inbox/video/init/', accessToken, {
      body: { source_info: buildSourceInfo(source) },
    });
  }

  /** Scope: video.publish or video.upload. Poll the status of a post. */
  getPostStatus(accessToken, publishId) {
    return this.#apiRequest('POST', '/v2/post/publish/status/fetch/', accessToken, {
      body: { publish_id: publishId },
    });
  }

  /**
   * Upload a video buffer to the `upload_url` returned by directPostVideo /
   * uploadVideoDraft when using FILE_UPLOAD. Chunks must match what was
   * declared at init time (see planChunks()).
   */
  async uploadVideo(uploadUrl, video, { chunkSize = planChunks(video.length).chunkSize, contentType = 'video/mp4' } = {}) {
    const total = video.length;
    for (let start = 0; start < total; start += chunkSize) {
      // TikTok folds any trailing remainder into the final chunk.
      const isLast = start + 2 * chunkSize > total;
      const end = isLast ? total : start + chunkSize;
      const res = await this.fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(end - start),
          'Content-Range': `bytes ${start}-${end - 1}/${total}`,
        },
        body: video.subarray(start, end),
      });
      if (!res.ok) {
        throw new TikTokError(`Video upload failed with HTTP ${res.status}`, {
          status: res.status,
          body: await res.text().catch(() => undefined),
        });
      }
      if (isLast) break;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async #tokenRequest(path, form) {
    if (!this.clientSecret) throw new Error('clientSecret is required for token requests');
    const res = await this.fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        ...form,
      }),
    });
    const body = await parseJson(res);
    // OAuth endpoints report failure as { error, error_description, log_id }.
    if (!res.ok || (typeof body?.error === 'string' && body.error)) {
      throw new TikTokError(body?.error_description || body?.error || `HTTP ${res.status}`, {
        code: body?.error,
        logId: body?.log_id,
        status: res.status,
        body,
      });
    }
    return body;
  }

  async #apiRequest(method, path, accessToken, { fields, body } = {}) {
    if (!accessToken) throw new Error('accessToken is required');
    const url = new URL(path, API_BASE);
    if (fields?.length) url.searchParams.set('fields', fields.join(','));
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';

    const res = await this.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await parseJson(res);
    // Open API endpoints report errors as { error: { code, message, log_id } }.
    const err = json?.error;
    if (!res.ok || (err && err.code !== 'ok')) {
      throw new TikTokError(err?.message || `HTTP ${res.status}`, {
        code: err?.code,
        logId: err?.log_id,
        status: res.status,
        body: json,
      });
    }
    return json?.data ?? {};
  }
}

/**
 * Work out chunk parameters for a FILE_UPLOAD. TikTok requires chunks of
 * 5–64 MB (the last may be up to 128 MB); files under 5 MB go in one chunk.
 */
export function planChunks(videoSize, preferredChunkSize = 10 * 1024 * 1024) {
  const MIN = 5 * 1024 * 1024;
  const MAX = 64 * 1024 * 1024;
  if (videoSize <= MIN) return { chunkSize: videoSize, totalChunkCount: 1 };
  const chunkSize = Math.min(Math.max(preferredChunkSize, MIN), MAX);
  return { chunkSize, totalChunkCount: Math.max(1, Math.floor(videoSize / chunkSize)) };
}

function buildSourceInfo(source = {}) {
  if (source.videoUrl) return { source: 'PULL_FROM_URL', video_url: source.videoUrl };
  if (source.videoSize) {
    const plan = planChunks(source.videoSize, source.chunkSize);
    return {
      source: 'FILE_UPLOAD',
      video_size: source.videoSize,
      chunk_size: source.chunkSize ?? plan.chunkSize,
      total_chunk_count: source.totalChunkCount ?? plan.totalChunkCount,
    };
  }
  throw new Error('source must include either videoUrl or videoSize');
}

async function parseJson(res) {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new TikTokError(`Non-JSON response (HTTP ${res.status})`, { status: res.status, body: text });
  }
}
