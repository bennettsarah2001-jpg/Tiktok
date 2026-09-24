# TikTok integration

A Node.js (18+) client for TikTok's official v2 Open APIs, plus account analytics and trend-based content suggestions:

- **Login Kit**: OAuth 2.0 with PKCE, token exchange, refresh, revoke, and client credentials
- **Display API**: user profile, list and query the user's videos (with pagination)
- **Content Posting API**: post directly to a profile, send drafts to the inbox, upload chunked files, poll post status
- **Insights**: analyze a creator's videos, research current TikTok trends with Claude and web search, and get concrete video ideas

The TikTok client itself has no dependencies. The suggestions feature uses `@anthropic-ai/sdk`.

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

## Account analysis and video suggestions

```sh
npm install

# Try it on the bundled sample data (a fictional cooking account)
node examples/analyze.js --videos examples/sample-videos.json --no-suggest   # analytics only
ANTHROPIC_API_KEY=sk-ant-... node examples/analyze.js --videos examples/sample-videos.json

# Run it on a real account: the token needs the user.info.basic and video.list scopes
TIKTOK_ACCESS_TOKEN=act.... ANTHROPIC_API_KEY=sk-ant-... \
  node examples/analyze.js --tz America/New_York --niche "home cooking" --json report.json
```

In the demo server, a logged-in user can open `/insights` for the same report.

It runs in two stages:

1. **Analytics** (`analyzeVideos`, local and free). Pulls every video with view, like, comment and share counts, then reports:
   - totals and medians, engagement rate, and posting cadence
   - momentum: recent videos compared with earlier ones
   - top, most-engaging and weakest videos
   - how each weekday, 3-hour posting window, video length and repeated hashtag performs against the account's typical (median) views
2. **Trends and ideas** (`suggestContent`). Claude (`claude-opus-5`) runs two requests:
   - It uses the web search tool to research what's trending on TikTok right now (sounds, hashtags, formats, challenges, memes), steered toward the creator's niche.
   - It combines that research with the analytics and returns structured JSON (`SUGGESTIONS_SCHEMA`): a summary, strengths and weaknesses, the relevant trends with source URLs, and video ideas. Each idea has a hook, a shot-by-shot outline, a caption, hashtags, a length, a posting time, and the data behind it. It ends with a one-week posting plan.

```js
import { TikTokClient, ANALYTICS_VIDEO_FIELDS, analyzeVideos, suggestContent } from './src/index.js';

const videos = [];
for await (const v of tiktok.iterateVideos(token, { fields: ANALYTICS_VIDEO_FIELDS })) videos.push(v);
const analytics = analyzeVideos(videos, { timeZone: 'America/New_York' });
const { suggestions, sources } = await suggestContent({ analytics, niche: 'home cooking', region: 'US' });
```

Notes:

- TikTok has no public trends API for regular apps, so trends come from live web search. Each trend links its source; check them before you build a video around one.
- The Display API only returns public counts for the user's own videos. It has no watch time, retention or follower-demographics data, which are only in TikTok Studio.
- Requests opt into server-side refusal fallbacks (`fallbacks: "default"`). A suggestion run makes several web searches plus two model calls, so expect it to take a few minutes and to cost more than a single chat request.

## Tests

```sh
npm test
```
