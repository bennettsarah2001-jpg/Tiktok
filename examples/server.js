// Minimal "Login with TikTok" demo using only node:http.
//
//   cp .env.example .env   # fill in your app credentials
//   node --env-file=.env examples/server.js
//
// Then open http://localhost:3000 and click "Login with TikTok".
// Sessions are kept in memory; use a real session store in production.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { TikTokClient, createState, createPkcePair } from '../src/index.js';

const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI, PORT = 3000 } = process.env;
if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_REDIRECT_URI) {
  console.error('Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI (see .env.example).');
  process.exit(1);
}

const tiktok = new TikTokClient({
  clientKey: TIKTOK_CLIENT_KEY,
  clientSecret: TIKTOK_CLIENT_SECRET,
  redirectUri: TIKTOK_REDIRECT_URI,
});
const SCOPES = ['user.info.basic', 'video.list'];
const sessions = new Map();
const callbackPath = new URL(TIKTOK_REDIRECT_URI).pathname;

function getSession(req, res) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  const id = randomBytes(16).toString('hex');
  const session = {};
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Lax; Path=/`);
  return session;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>TikTok demo</title>${html}`);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const session = getSession(req, res);

  if (url.pathname === '/') {
    if (!session.tokens) return send(res, 200, '<a href="/auth/tiktok">Login with TikTok</a>');
    const user = await tiktok.getUserInfo(session.tokens.access_token);
    const { videos = [] } = await tiktok.listVideos(session.tokens.access_token, { maxCount: 10 });
    return send(
      res,
      200,
      `<h1>Hi, ${escapeHtml(user.display_name)}</h1>
       <img src="${escapeHtml(user.avatar_url)}" width="64" alt="">
       <h2>Recent videos</h2>
       <ul>${videos
         .map((v) => `<li><a href="${escapeHtml(v.share_url)}">${escapeHtml(v.title || v.id)}</a></li>`)
         .join('')}</ul>
       <form method="post" action="/logout"><button>Disconnect</button></form>`,
    );
  }

  if (url.pathname === '/auth/tiktok') {
    const state = createState();
    const { verifier, challenge } = createPkcePair();
    Object.assign(session, { state, verifier });
    res.writeHead(302, {
      Location: tiktok.getAuthorizationUrl({ scopes: SCOPES, state, codeChallenge: challenge }),
    });
    return res.end();
  }

  if (url.pathname === callbackPath) {
    const error = url.searchParams.get('error');
    if (error) return send(res, 400, `Authorization failed: ${escapeHtml(error)}`);
    if (!session.state || url.searchParams.get('state') !== session.state) {
      return send(res, 400, 'Invalid state');
    }
    session.tokens = await tiktok.exchangeCode({
      code: url.searchParams.get('code'),
      codeVerifier: session.verifier,
    });
    delete session.state;
    delete session.verifier;
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  if (url.pathname === '/logout' && req.method === 'POST') {
    if (session.tokens) await tiktok.revokeToken(session.tokens.access_token).catch(() => {});
    delete session.tokens;
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  send(res, 404, 'Not found');
}

createServer((req, res) =>
  handle(req, res).catch((err) => {
    console.error(err);
    send(res, 500, `Error: ${escapeHtml(err.message)}`);
  }),
).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
