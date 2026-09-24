import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5';
// Re-runs a declined request on Anthropic's recommended fallback model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_CONTINUATIONS = 5;

const TREND_TYPES = ['sound', 'hashtag', 'format', 'challenge', 'topic', 'meme'];

export const SUGGESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'strengths', 'weaknesses', 'trends', 'suggestions', 'posting_plan'],
  properties: {
    summary: { type: 'string', description: "Two or three sentences on how the account is doing." },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    trends: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'description', 'relevance', 'source_url'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: TREND_TYPES },
          description: { type: 'string' },
          relevance: { type: 'string', description: 'Why this trend fits this creator.' },
          source_url: { type: 'string', description: 'Where the trend was found; empty if none.' },
        },
      },
    },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'trend',
          'hook',
          'concept',
          'outline',
          'caption',
          'hashtags',
          'length_seconds',
          'post_when',
          'rationale',
        ],
        properties: {
          title: { type: 'string' },
          trend: { type: 'string', description: 'Name of the trend used, or empty for evergreen ideas.' },
          hook: { type: 'string', description: 'What is said or shown in the first 2 seconds.' },
          concept: { type: 'string' },
          outline: { type: 'array', items: { type: 'string' }, description: 'Shot-by-shot beats.' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          length_seconds: { type: 'integer' },
          post_when: { type: 'string', description: "Day and time, in the analysis time zone." },
          rationale: { type: 'string', description: "Which data from the creator's own analytics supports this idea." },
        },
      },
    },
    posting_plan: { type: 'string', description: 'A one-week posting plan using the suggestions.' },
  },
};

/**
 * Research current TikTok trends with web search, then turn them and the
 * creator's analytics into concrete video ideas.
 *
 * @param {object} opts
 * @param {object} opts.analytics  Result of analyzeVideos()
 * @param {object} [opts.profile]  Result of TikTokClient#getUserInfo()
 * @param {string} [opts.niche]    Creator's niche, if known (otherwise inferred)
 * @param {string} [opts.region]   Market to focus trend research on, e.g. "US"
 * @param {number} [opts.count]    Number of video ideas to produce
 * @param {Anthropic} [opts.anthropic] Client (defaults to one using ANTHROPIC_API_KEY)
 * @returns {Promise<{ research: string, sources: {title: string, url: string}[], suggestions: object }>}
 */
export async function suggestContent({
  analytics,
  profile,
  niche,
  region = 'US',
  count = 5,
  model = DEFAULT_MODEL,
  anthropic = new Anthropic(),
  now = new Date(),
}) {
  if (!analytics) throw new Error('analytics is required');
  const creator = describeCreator({ analytics, profile, niche });

  const { text: research, sources } = await researchTrends({ anthropic, model, creator, region, now });

  const message = await anthropic.beta.messages
    .stream({
      model,
      max_tokens: 32000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SUGGESTIONS_SCHEMA } },
      system:
        "You are a TikTok content strategist. Ground every recommendation in the creator's own " +
        'analytics and in the trend research provided. Do not invent statistics. ' +
        'Prefer trends with room to grow over ones that are already saturated.',
      messages: [
        {
          role: 'user',
          content:
            `${creator}\n\n<trend_research date="${now.toISOString().slice(0, 10)}">\n${research}\n</trend_research>\n\n` +
            `Produce exactly ${count} video suggestions. Most should use a trend from the research that fits ` +
            'this creator; one may be an evergreen idea that doubles down on what already works for them. ' +
            `Time recommendations are in ${analytics.timeZone}.`,
        },
      ],
    })
    .finalMessage();

  assertCompleted(message);
  const text = message.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no suggestions');
  return { research, sources, suggestions: JSON.parse(text) };
}

async function researchTrends({ anthropic, model, creator, region, now }) {
  const messages = [
    {
      role: 'user',
      content:
        `Today is ${now.toISOString().slice(0, 10)}. Use web search to find what is trending on TikTok ` +
        `in the ${region} right now (the last two weeks): sounds, hashtags, formats, challenges, memes ` +
        'and topics. Prioritize trends relevant to the creator below, but include a couple of broad ' +
        'trends that could be adapted to their niche.\n\n' +
        `${creator}\n\n` +
        'For each trend give its name, what it is, how people are using it, whether it is still rising ' +
        'or already peaking, and the source URL. Skip anything you cannot confirm is current.',
    },
  ];

  // Server-side search loops can stop with pause_turn; resend the turn so far
  // and the server resumes it. Resumed responses continue the same turn.
  const content = [];
  let message;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    message = await anthropic.beta.messages
      .stream({
        model,
        max_tokens: 32000,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10 }],
        messages: content.length ? [...messages, { role: 'assistant', content }] : messages,
      })
      .finalMessage();
    content.push(...message.content);
    if (message.stop_reason !== 'pause_turn') break;
  }
  assertCompleted(message);

  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const sources = new Map();
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) sources.set(r.url, { title: r.title, url: r.url });
    }
  }
  return { text, sources: [...sources.values()] };
}

function assertCompleted(message) {
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${message.stop_details?.category ?? 'no category'})`);
  }
  if (message.stop_reason === 'max_tokens') throw new Error('Claude response was truncated (max_tokens)');
  if (message.stop_reason === 'pause_turn') throw new Error('Trend research did not finish');
}

/** Compact, prompt-friendly description of the creator from their analytics. */
export function describeCreator({ analytics: a, profile, niche }) {
  const video = (v) =>
    `- "${v.title.slice(0, 120)}" (${v.views} views, ${(v.engagementRate * 100).toFixed(1)}% engagement, ${v.durationSec}s)`;
  const group = (g) => `${g.key}: ${g.videos} videos, ${g.performance}x typical views`;
  return [
    '<creator>',
    profile?.display_name ? `Name: ${profile.display_name}` : null,
    profile?.bio_description ? `Bio: ${profile.bio_description}` : null,
    niche ? `Niche: ${niche}` : 'Niche: infer it from the video titles and hashtags below.',
    `Videos analyzed: ${a.totals.videos}; median views ${a.medians.views}; median engagement ${(a.medians.engagementRate * 100).toFixed(1)}%; median length ${a.medians.durationSec}s`,
    `Posts every ${a.cadence.medianDaysBetweenPosts} days (median). Momentum: ${a.momentum.change == null ? 'n/a' : `${Math.round(a.momentum.change * 100)}% change in median views, recent vs earlier videos`}`,
    'Best videos by views:',
    ...a.topByViews.map(video),
    'Best videos by engagement:',
    ...a.topByEngagement.map(video),
    'Weakest videos:',
    ...a.bottomByViews.map(video),
    `By weekday (${a.timeZone}): ${a.byWeekday.map(group).join('; ')}`,
    `By time posted (${a.timeZone}): ${a.byTimeOfDay.map(group).join('; ')}`,
    `By length: ${a.byDuration.map(group).join('; ')}`,
    a.hashtags.length ? `Hashtags: ${a.hashtags.map(group).join('; ')}` : null,
    '</creator>',
  ]
    .filter(Boolean)
    .join('\n');
}
