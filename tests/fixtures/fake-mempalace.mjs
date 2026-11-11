#!/usr/bin/env node
// A stand-in for the MemPalace command line, for tests only: the same commands the office uses (`--version`,
// `init`, `mine`, `search`), the same shape of output, and a search that counts shared words instead of comparing
// meaning. It keeps what it "filed" in <palace>/fake-index.json and writes every call to <palace>/calls.log.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const take = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const [, v] = argv.splice(i, 2);
  return v;
};
const palace = take('--palace') ?? path.join(process.cwd(), 'palace');
fs.mkdirSync(palace, { recursive: true });
const log = (line) => fs.appendFileSync(path.join(palace, 'calls.log'), `${Date.now()} ${line}\n`);
const index = path.join(palace, 'fake-index.json');
const read = () => (fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv.includes('--version')) {
  console.log('MemPalace 9.9.9');
  process.exit(0);
}
const [cmd, target] = argv;
log(`start ${cmd}`);
// (Real runs take seconds; long enough here for two of them to overlap if the office let them.)
await sleep(Number(process.env.FAKE_MEMPALACE_MS ?? 150));
if (cmd === 'init') {
  fs.writeFileSync(path.join(target, 'mempalace.yaml'), 'wing: records\n');
  console.log(`  Config saved: ${path.join(target, 'mempalace.yaml')}`);
} else if (cmd === 'mine') {
  const have = read();
  const known = new Set(have.map((d) => `${d.room}/${d.source}`));
  let filed = 0;
  for (const room of fs.readdirSync(target, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(target, room.name)).filter((x) => x.endsWith('.md'))) {
      if (known.has(`${room.name}/${f}`)) continue;
      have.push({ room: room.name, source: f, text: fs.readFileSync(path.join(target, room.name, f), 'utf8') });
      filed++;
    }
  }
  fs.writeFileSync(index, JSON.stringify(have));
  console.log(`  Done.\n  Drawers filed: ${filed}`);
} else if (cmd === 'search') {
  const wing = take('--wing') ?? 'office';
  const results = Number(take('--results') ?? 5);
  const room = take('--room');
  const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9šđčćž]+/).filter((w) => w.length > 2));
  const q = words(target ?? '');
  const scored = read()
    .filter((d) => !room || d.room === room)
    .map((d) => {
      const t = words(d.text);
      const hit = [...q].filter((w) => t.has(w)).length;
      return { ...d, score: q.size ? hit / q.size : 0 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, results);
  console.log(`\n============================================================\n  Results for: "${target}"\n============================================================\n`);
  scored.forEach((d, i) => {
    console.log(`  [${i + 1}] ${wing} / ${d.room}\n      Source: ${d.source}\n      Match:  cosine_sim=${d.score.toFixed(3)}  bm25=${(d.score * 4).toFixed(3)}\n`);
    console.log(d.text.trimEnd().split('\n').map((l) => `      ${l}`).join('\n'));
    console.log('\n  --------------------------------------------------------');
  });
} else {
  console.error(`fake mempalace: unknown command ${cmd}`);
  log(`end ${cmd} failed`);
  process.exit(2);
}
log(`end ${cmd}`);
