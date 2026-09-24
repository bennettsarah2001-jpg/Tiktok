// Analyze a TikTok account and suggest videos based on current trends.
//
//   # Real account (access token needs the user.info.basic and video.list scopes)
//   TIKTOK_ACCESS_TOKEN=act.xxx ANTHROPIC_API_KEY=sk-ant-xxx node examples/analyze.js
//
//   # Try it with the bundled sample data
//   node examples/analyze.js --videos examples/sample-videos.json
//
// Options:
//   --videos <file>    Analyze a JSON array of videos instead of calling TikTok
//   --niche <text>     Creator's niche (otherwise inferred from their videos)
//   --region <code>    Market for trend research (default US)
//   --tz <zone>        IANA time zone for posting-time analysis (default UTC)
//   --count <n>        Number of video ideas (default 5)
//   --no-suggest       Only print the analytics report (no Claude call)
//   --json <file>      Also write the full result as JSON
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  TikTokClient,
  ANALYTICS_VIDEO_FIELDS,
  analyzeVideos,
  formatReport,
  suggestContent,
} from '../src/index.js';

const { values: args } = parseArgs({
  options: {
    videos: { type: 'string' },
    niche: { type: 'string' },
    region: { type: 'string', default: 'US' },
    tz: { type: 'string', default: 'UTC' },
    count: { type: 'string', default: '5' },
    'no-suggest': { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});

let videos;
let profile;
if (args.videos) {
  videos = JSON.parse(await readFile(args.videos, 'utf8'));
} else {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) {
    console.error('Set TIKTOK_ACCESS_TOKEN, or pass --videos <file>. See README.');
    process.exit(1);
  }
  const tiktok = new TikTokClient({ clientKey: process.env.TIKTOK_CLIENT_KEY ?? 'unused' });
  profile = await tiktok.getUserInfo(token, ['open_id', 'display_name', 'bio_description', 'follower_count']).catch(
    () => tiktok.getUserInfo(token), // bio/follower fields need extra scopes
  );
  videos = [];
  for await (const v of tiktok.iterateVideos(token, { fields: ANALYTICS_VIDEO_FIELDS })) videos.push(v);
}

if (!videos.length) {
  console.error('No videos found to analyze.');
  process.exit(1);
}

const analytics = analyzeVideos(videos, { timeZone: args.tz });
console.log(`\n=== Account analysis${profile?.display_name ? `: ${profile.display_name}` : ''} ===\n`);
console.log(formatReport(analytics));

let result;
if (!args['no-suggest']) {
  console.log('\nResearching current TikTok trends and drafting ideas (this can take a few minutes)...');
  result = await suggestContent({
    analytics,
    profile,
    niche: args.niche,
    region: args.region,
    count: Number(args.count),
  });
  const s = result.suggestions;
  console.log(`\n=== Summary ===\n${s.summary}`);
  console.log(`\nStrengths:\n${s.strengths.map((x) => `  + ${x}`).join('\n')}`);
  console.log(`Weaknesses:\n${s.weaknesses.map((x) => `  - ${x}`).join('\n')}`);
  console.log('\n=== Current trends ===');
  for (const t of s.trends) {
    console.log(`\n* ${t.name} [${t.type}]\n  ${t.description}\n  Why it fits: ${t.relevance}${t.source_url ? `\n  ${t.source_url}` : ''}`);
  }
  console.log('\n=== Video ideas ===');
  s.suggestions.forEach((v, i) => {
    console.log(`\n${i + 1}. ${v.title}${v.trend ? `  (trend: ${v.trend})` : ''}`);
    console.log(`   Hook: ${v.hook}`);
    console.log(`   ${v.concept}`);
    v.outline.forEach((beat, j) => console.log(`     ${j + 1}) ${beat}`));
    console.log(`   Caption: ${v.caption} ${v.hashtags.join(' ')}`);
    console.log(`   Length: ~${v.length_seconds}s | Post: ${v.post_when}`);
    console.log(`   Why: ${v.rationale}`);
  });
  console.log(`\n=== This week ===\n${s.posting_plan}\n`);
}

if (args.json) {
  await writeFile(args.json, JSON.stringify({ profile, analytics, ...result }, null, 2));
  console.log(`Wrote ${args.json}`);
}
