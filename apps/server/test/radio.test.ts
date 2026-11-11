import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isInside, nowPlaying, outsideAddress } from '../src/radio.ts';

test('which addresses are this machine or its own network', () => {
  for (const a of ['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '<server-lan-ip>', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1', 'not-an-address', '']) {
    assert.equal(isInside(a), true, a);
  }
  for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '192.169.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isInside(a), false, a);
});

test('an address the office may ask: a web address whose name leads outside, every time', async () => {
  const names: Record<string, string[]> = { 'radio.example': ['93.184.216.34'], 'inside.example': ['10.0.0.5'], 'both.example': ['93.184.216.34', '127.0.0.1'], 'nowhere.example': [] };
  const resolve = async (host: string) => {
    if (!(host in names)) throw new Error('ENOTFOUND');
    return names[host]!;
  };
  const ok = (url: string) => outsideAddress(url, resolve);
  assert.equal(await ok('https://radio.example/now.json'), true);
  assert.equal(await ok('http://93.184.216.34:8000/status-json.xsl'), true);
  assert.equal(await ok('http://inside.example/now'), false, 'a name that leads inside');
  assert.equal(await ok('http://both.example/now'), false, 'one of its addresses is inside');
  assert.equal(await ok('http://nowhere.example/now'), false);
  assert.equal(await ok('http://unknown.example/now'), false, 'a name that does not resolve');
  for (const url of ['http://127.0.0.1:4600/api/state', 'http://[::1]:4600/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.0.1/', 'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.1/', 'ftp://radio.example/now', 'file:///etc/passwd', 'not an address']) {
    assert.equal(await ok(url), false, url);
  }
});

test('what is on air is not asked of this machine when the office is reached from outside; redirects are followed by hand, a few', async () => {
  const asked: string[] = [];
  const station = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    const hop = /^\/hop(\d)$/.exec(req.url ?? '');
    if (hop) {
      const n = Number(hop[1]);
      res.writeHead(302, { location: n > 1 ? `/hop${n - 1}` : '/now' });
      return void res.end();
    }
    if (req.url === '/away') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return void res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ artist: 'Artist', title: 'Song' }));
  });
  await new Promise<void>((r) => station.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(station.address() as AddressInfo).port}`;
  try {
    // The door is open: a saved address on this machine is not asked at all.
    assert.equal(await nowPlaying(`${at}/now?door`), null);
    assert.equal(await nowPlaying(`${at}/hop1?door`), null);
    assert.deepEqual(asked, [], 'no request was made');
    // An office that only its own machine reaches may ask a station beside it.
    assert.equal(await nowPlaying(`${at}/now`, { insideToo: true }), 'Artist - Song');
    assert.equal(await nowPlaying(`${at}/hop3`, { insideToo: true }), 'Artist - Song', 'sent on three times');
    assert.equal(await nowPlaying(`${at}/hop4`, { insideToo: true }), null, 'four times is once too often');
    assert.equal(await nowPlaying(`${at}/away`, { insideToo: true }), null, 'sent on to something that is not a web address');
  } finally {
    station.close();
  }
});
