# TikTok integration

A zero-dependency Node.js (18+) client for TikTok's official v2 Open APIs:

- **Login Kit**: OAuth 2.0 with PKCE, token exchange, refresh, revoke, and client credentials
- **Display API**: user profile, list and query the user's videos (with pagination)
- **Content Posting API**: post directly to a profile, send drafts to the inbox, upload chunked files, poll post status

## Setup

1. Create an app at <https://developers.tiktok.com/apps>.
2. Add the **Login Kit** product and register a redirect URI (e.g. `http://localhost:3000/auth/tiktok/callback`).
3. Add the products and scopes you need:
   | Scope | Used by |
   | --- | --- |
   | `user.info.basic` (plus `user.info.profile` and `user.info.stats`) | `getUserInfo` |
   | `video.list` | `listVideos`, `iterateVideos`, `queryVideos` |
   | `video.publish` | `queryCreatorInfo`, `directPostVideo` |
   | `video.upload` | `uploadVideoDraft` |
4. `cp .env.example .env` and fill in your client key and secret.

## Run the demo

```sh
node --env-file=.env examples/server.js
```

Open <http://localhost:3000> and click **Login with TikTok**. The demo shows your profile and recent videos.

## Usage

```js
import { TikTokClient, createState, createPkcePair } from './src/index.js';

const tiktok = new TikTokClient({
  clientKey: process.env.TIKTOK_CLIENT_KEY,
  clientSecret: process.env.TIKTOK_CLIENT_SECRET,
  redirectUri: process.env.TIKTOK_REDIRECT_URI,
});

// 1. Redirect the user (store state and verifier in their session)
const state = createState();
const { verifier, challenge } = createPkcePair();
const url = tiktok.getAuthorizationUrl({ scopes: ['user.info.basic', 'video.list'], state, codeChallenge: challenge });

// 2. In the callback, check `state`, then exchange the code
const { access_token, refresh_token, expires_in } = await tiktok.exchangeCode({ code, codeVerifier: verifier });

// 3. Call the API
const user = await tiktok.getUserInfo(access_token);
for await (const video of tiktok.iterateVideos(access_token)) console.log(video.title);

// Access tokens last about 24h; refresh tokens last about 365 days
const fresh = await tiktok.refreshToken(refresh_token);
```

### Posting videos

```js
// Direct post. Always query creator info first and use one of its privacy levels.
const creator = await tiktok.queryCreatorInfo(accessToken);
const { publish_id } = await tiktok.directPostVideo(accessToken, {
  postInfo: { title: 'Hello #tiktok', privacy_level: creator.privacy_level_options[0] },
  source: { videoUrl: 'https://your-verified-domain.com/video.mp4' }, // PULL_FROM_URL
});

// Or upload a local file as a draft to the user's inbox
import { readFile } from 'node:fs/promises';
import { planChunks } from './src/index.js';

const video = await readFile('clip.mp4');
const { chunkSize, totalChunkCount } = planChunks(video.length);
const { upload_url, publish_id: id } = await tiktok.uploadVideoDraft(accessToken, {
  source: { videoSize: video.length, chunkSize, totalChunkCount },
});
await tiktok.uploadVideo(upload_url, video, { chunkSize });

const status = await tiktok.getPostStatus(accessToken, id); // e.g. { status: 'SEND_TO_USER_INBOX' }
```

Notes:

- `PULL_FROM_URL` only works for domains or URL prefixes you have verified in the developer portal.
- Until TikTok audits your app, direct posts from unaudited clients are limited to `SELF_ONLY` (private) visibility.

### Errors

Every failed call throws a `TikTokError` with `code` (e.g. `access_token_invalid`, `invalid_grant`), `logId` (include this when you contact TikTok support), `status`, and the raw `body`.

## Tests

```sh
npm test
```
