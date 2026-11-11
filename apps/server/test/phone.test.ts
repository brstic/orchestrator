import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhone, phonePage } from '../src/phone.ts';

const PHONES = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Android 15; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  'Opera/9.80 (Android; Opera Mini/8.0.1807/36.1609; U; en) Presto/2.12.423 Version/12.16',
];
const NOT_PHONES = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // The desktop app, and what talks to the office without being a person at all.
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orchestrator/0.1.0 Chrome/130.0.6723.137 Electron/33.2.0 Safari/537.36',
  'node',
  'undici',
  'claude-code/2.1.322',
  // Tablets are let in: an iPad says it is a Mac, an Android tablet does not say "Mobile".
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  '',
];

test('a phone is told from a computer by what its browser says it is', () => {
  for (const ua of PHONES) assert.equal(isPhone(ua), true, ua);
  for (const ua of NOT_PHONES) assert.equal(isPhone(ua), false, ua);
  for (const odd of [undefined, null, 42, ['Mobile']]) assert.equal(isPhone(odd), false);
});

test('the page a phone gets names the office, says what to do, and cannot be made to carry markup', () => {
  const page = phonePage('Acme <script>alert(1)</script> & Sons');
  assert.match(page, /opens on a computer/);
  assert.match(page, /desktop or laptop computer/);
  assert.match(page, /has <strong>not<\/strong> been used up/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /Acme &#60;script&#62;/);
});
