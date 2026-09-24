import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { analyzeVideos, extractHashtags, engagementRate, formatReport, suggestContent } from '../src/index.js';

const DAY = 86400;
const T0 = Date.UTC(2026, 8, 7, 15) / 1000; // Mon 2026-09-07 15:00 UTC

const video = (i, over = {}) => ({
  id: String(i),
  title: `Video ${i} #cooking`,
  duration: 20,
  create_time: T0 + i * DAY,
  view_count: 1000,
  like_count: 80,
  comment_count: 10,
  share_count: 10,
  ...over,
});

test('extractHashtags dedupes and lowercases, including non-Latin tags', () => {
  assert.deepEqual(extractHashtags('Hi #FoodTok #foodtok #料理 #a_b!'), ['#foodtok', '#料理', '#a_b']);
});

test('engagementRate handles zero views', () => {
  assert.equal(engagementRate(video(1)), 0.1);
  assert.equal(engagementRate(video(1, { view_count: 0 })), 0);
});

test('analyzeVideos computes totals, momentum, groupings', () => {
  const vs = [
    video(0, { view_count: 1000 }),
    video(1, { view_count: 2000 }),
    video(2, { view_count: 3000, duration: 90, title: 'Long one #cooking #recipe' }),
    video(3, { view_count: 9000, title: 'Hit #cooking #recipe' }),
  ];
  const a = analyzeVideos(vs);
  assert.equal(a.totals.videos, 4);
  assert.equal(a.totals.views, 15000);
  assert.equal(a.medians.views, 2500);
  assert.equal(a.cadence.medianDaysBetweenPosts, 1);
  assert.equal(a.momentum.olderMedianViews, 1500);
  assert.equal(a.momentum.recentMedianViews, 6000);
  assert.equal(a.momentum.change, 3);
  assert.equal(a.topByViews[0].title, 'Hit #cooking #recipe');
  assert.deepEqual(a.byWeekday.map((g) => g.key), ['Mon', 'Tue', 'Wed', 'Thu']);
  assert.deepEqual(a.byTimeOfDay.map((g) => g.key), ['15:00-18:00']);
  // Ranked by performance: the one long video (3000) beats the short ones' median (2000).
  assert.deepEqual(
    a.byDuration.map((g) => [g.key, g.videos, g.performance]),
    [['1-3min', 1, 1.2], ['15-30s', 3, 0.8]],
  );
  const recipe = a.hashtags.find((h) => h.key === '#recipe');
  assert.equal(recipe.videos, 2);
  assert.equal(recipe.performance, 2.4); // median 6000 / 2500
  assert.match(formatReport(a), /Videos analyzed: 4/);
});

test('analyzeVideos buckets posting times in the requested time zone', () => {
  const a = analyzeVideos([video(0)], { timeZone: 'America/Los_Angeles' });
  assert.deepEqual(a.byWeekday.map((g) => g.key), ['Mon']);
  assert.deepEqual(a.byTimeOfDay.map((g) => g.key), ['06:00-09:00']); // 15:00 UTC = 08:00 PDT
});

test('analyzeVideos tolerates an empty list', () => {
  const a = analyzeVideos([]);
  assert.equal(a.totals.videos, 0);
  assert.equal(a.momentum.change, null);
  formatReport(a);
});

const SUGGESTIONS = {
  summary: 's',
  strengths: ['short videos'],
  weaknesses: ['long videos'],
  trends: [{ name: 'T', type: 'sound', description: 'd', relevance: 'r', source_url: 'https://x' }],
  suggestions: [],
  posting_plan: 'p',
};

/** Fake Anthropic client that returns queued messages from beta.messages.stream(). */
function fakeAnthropic(...messages) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream: (params) => {
          calls.push(structuredClone(params));
          return { finalMessage: async () => messages.shift() };
        },
      },
    },
  };
}

test('suggestContent researches trends with web search, then returns structured ideas', async () => {
  const anthropic = fakeAnthropic(
    {
      stop_reason: 'pause_turn',
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'tiktok trends' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'A', url: 'https://a' }] },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Trend T is rising.' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(SUGGESTIONS) }] },
  );
  const analytics = analyzeVideos([video(0), video(1)]);
  const result = await suggestContent({ analytics, niche: 'cooking', anthropic, now: new Date('2026-09-24') });

  assert.equal(result.research, 'Trend T is rising.');
  assert.deepEqual(result.sources, [{ title: 'A', url: 'https://a' }]);
  assert.deepEqual(result.suggestions, SUGGESTIONS);

  const [first, resumed, final] = anthropic.calls;
  assert.equal(first.tools[0].type, 'web_search_20260209');
  assert.equal(first.fallbacks, 'default');
  assert.match(first.messages[0].content, /Today is 2026-09-24/);
  assert.match(first.messages[0].content, /Niche: cooking/);
  // pause_turn: the paused assistant content is sent back so the server resumes.
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.messages[1].role, 'assistant');
  assert.equal(resumed.messages[1].content[0].type, 'server_tool_use');
  assert.equal(final.output_config.format.type, 'json_schema');
  assert.equal(final.tools, undefined);
  assert.match(final.messages[0].content, /Trend T is rising\./);
});

test('suggestContent surfaces refusals', async () => {
  const anthropic = fakeAnthropic({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
  await assert.rejects(suggestContent({ analytics: analyzeVideos([video(0)]), anthropic }), /declined.*cyber/);
});

/** Minimal SSE body for one streamed message with a single text block. */
function sse(text) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

test('requests sent through the real SDK carry the expected wire format', async () => {
  const requests = [];
  const replies = ['Trend research.', JSON.stringify(SUGGESTIONS)];
  const anthropic = new Anthropic({
    apiKey: 'test-key',
    fetch: async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(sse(replies.shift()), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const result = await suggestContent({ analytics: analyzeVideos([video(0)]), anthropic });
  assert.deepEqual(result.suggestions, SUGGESTIONS);

  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.match(r.url, /\/v1\/messages\?beta=true$/);
    assert.equal(r.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
    assert.equal(r.body.model, 'claude-opus-5');
    assert.equal(r.body.stream, true);
    assert.equal(r.body.fallbacks, 'default');
    assert.equal(r.body.betas, undefined);
  }
  assert.deepEqual(requests[0].body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10 }]);
  assert.equal(requests[1].body.output_config.format.type, 'json_schema');
});
