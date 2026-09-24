import { DEFAULT_VIDEO_FIELDS } from './client.js';

/** Video fields needed for analysis (all available with the video.list scope). */
export const ANALYTICS_VIDEO_FIELDS = [
  ...DEFAULT_VIDEO_FIELDS,
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DURATION_BUCKETS = [
  ['<15s', 0, 15],
  ['15-30s', 15, 30],
  ['30-60s', 30, 60],
  ['1-3min', 60, 180],
  ['3min+', 180, Infinity],
];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function extractHashtags(text = '') {
  return [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))];
}

/** Engagement rate: (likes + comments + shares) / views. */
export function engagementRate(v) {
  const views = v.view_count ?? 0;
  if (!views) return 0;
  return ((v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0)) / views;
}

/**
 * Group videos by key and report how each group performs relative to the
 * account's median views (performance > 1 means above the typical video).
 */
function groupPerformance(videos, keyFn, baselineViews, minCount = 1) {
  const groups = new Map();
  for (const v of videos) {
    for (const key of [keyFn(v)].flat()) {
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
  }
  return [...groups]
    .filter(([, vs]) => vs.length >= minCount)
    .map(([key, vs]) => {
      const medViews = median(vs.map((v) => v.view_count ?? 0));
      return {
        key,
        videos: vs.length,
        medianViews: medViews,
        avgEngagementRate: round(mean(vs.map(engagementRate)), 4),
        performance: baselineViews ? round(medViews / baselineViews) : 0,
      };
    })
    .sort((a, b) => b.performance - a.performance || b.videos - a.videos);
}

const pad = (h) => String(h).padStart(2, '0');
/** 3-hour posting window, e.g. "18:00-21:00". */
function timeBlock(hour) {
  if (hour == null || Number.isNaN(hour)) return undefined;
  const start = hour - (hour % 3);
  return `${pad(start)}:00-${pad(start + 3)}:00`;
}

function summarizeVideo(v) {
  return {
    id: v.id,
    title: v.title || v.video_description || '',
    url: v.share_url,
    createdAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
    durationSec: v.duration,
    views: v.view_count ?? 0,
    likes: v.like_count ?? 0,
    comments: v.comment_count ?? 0,
    shares: v.share_count ?? 0,
    engagementRate: round(engagementRate(v), 4),
    hashtags: extractHashtags(`${v.title ?? ''} ${v.video_description ?? ''}`),
  };
}

/**
 * Analyze a creator's videos (as returned by the Display API with
 * ANALYTICS_VIDEO_FIELDS). Times are bucketed in `timeZone` (default UTC).
 */
export function analyzeVideos(videos, { timeZone = 'UTC', topN = 5 } = {}) {
  const vs = videos.filter((v) => v && v.id);
  const views = vs.map((v) => v.view_count ?? 0);
  const baseline = median(views);

  const localParts = (v) => {
    if (!v.create_time) return {};
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(v.create_time * 1000));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return { weekday: get('weekday'), hour: Number(get('hour')) };
  };

  const times = vs.map((v) => v.create_time).filter(Boolean).sort((a, b) => a - b);
  const gapsDays = times.slice(1).map((t, i) => (t - times[i]) / 86400);
  const byEngagement = [...vs].sort((a, b) => engagementRate(b) - engagementRate(a));
  const byViews = [...vs].sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0));

  // Recent vs older half: is the account trending up or down?
  const chrono = [...vs].sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  const half = chrono.length >> 1;
  const olderMedian = median(chrono.slice(0, half).map((v) => v.view_count ?? 0));
  const recentMedian = median(chrono.slice(half).map((v) => v.view_count ?? 0));

  return {
    timeZone,
    totals: {
      videos: vs.length,
      views: sum(views),
      likes: sum(vs.map((v) => v.like_count ?? 0)),
      comments: sum(vs.map((v) => v.comment_count ?? 0)),
      shares: sum(vs.map((v) => v.share_count ?? 0)),
    },
    medians: {
      views: baseline,
      engagementRate: round(median(vs.map(engagementRate)), 4),
      durationSec: median(vs.map((v) => v.duration ?? 0)),
    },
    cadence: {
      firstPost: times.length ? new Date(times[0] * 1000).toISOString() : undefined,
      lastPost: times.length ? new Date(times.at(-1) * 1000).toISOString() : undefined,
      medianDaysBetweenPosts: round(median(gapsDays), 1),
    },
    momentum: {
      olderMedianViews: olderMedian,
      recentMedianViews: recentMedian,
      change: olderMedian ? round(recentMedian / olderMedian - 1) : null,
    },
    topByViews: byViews.slice(0, topN).map(summarizeVideo),
    topByEngagement: byEngagement.slice(0, topN).map(summarizeVideo),
    bottomByViews: byViews.slice(-topN).reverse().map(summarizeVideo),
    byWeekday: groupPerformance(vs, (v) => localParts(v).weekday, baseline).sort(
      (a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key),
    ),
    byTimeOfDay: groupPerformance(vs, (v) => timeBlock(localParts(v).hour), baseline).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    byDuration: groupPerformance(
      vs,
      (v) => DURATION_BUCKETS.find(([, lo, hi]) => (v.duration ?? 0) >= lo && (v.duration ?? 0) < hi)?.[0],
      baseline,
    ),
    hashtags: groupPerformance(
      vs,
      (v) => extractHashtags(`${v.title ?? ''} ${v.video_description ?? ''}`),
      baseline,
      2,
    ).slice(0, 15),
  };
}

/** Plain-text report of an analyzeVideos() result. */
export function formatReport(a) {
  const pct = (x) => `${round(x * 100, 1)}%`;
  const n = (x) => Math.round(x).toLocaleString('en-US');
  const lines = [
    `Videos analyzed: ${a.totals.videos}`,
    `Total views: ${n(a.totals.views)} | likes: ${n(a.totals.likes)} | comments: ${n(a.totals.comments)} | shares: ${n(a.totals.shares)}`,
    `Median views: ${n(a.medians.views)} | median engagement: ${pct(a.medians.engagementRate)} | median length: ${a.medians.durationSec}s`,
    `Posting cadence: every ${a.cadence.medianDaysBetweenPosts} days (median)`,
  ];
  if (a.momentum.change != null) {
    lines.push(
      `Momentum: recent median views ${n(a.momentum.recentMedianViews)} vs ${n(a.momentum.olderMedianViews)} earlier (${a.momentum.change >= 0 ? '+' : ''}${pct(a.momentum.change)})`,
    );
  }
  const section = (title, rows, fmt) => {
    if (!rows.length) return;
    lines.push('', title);
    for (const r of rows) lines.push(`  ${fmt(r)}`);
  };
  section('Top videos by views:', a.topByViews, (v) => `${n(v.views)} views, ${pct(v.engagementRate)} eng — ${v.title.slice(0, 60)}`);
  section('Top videos by engagement:', a.topByEngagement, (v) => `${pct(v.engagementRate)} eng, ${n(v.views)} views — ${v.title.slice(0, 60)}`);
  const count = (k) => `${k} video${k === 1 ? '' : 's'}`;
  const perf = (g) => `${String(g.key).padEnd(12)} ${count(g.videos).padStart(10)}, ${g.performance}x typical views`;
  section(`By weekday (${a.timeZone}):`, a.byWeekday, perf);
  section(`By time posted (${a.timeZone}):`, a.byTimeOfDay, perf);
  section('By length:', a.byDuration, perf);
  section('Hashtags (used 2+ times):', a.hashtags, (g) => `${g.key}: ${count(g.videos)}, ${g.performance}x typical views`);
  return lines.join('\n');
}
