import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { staysInOffice, externalUrl, pageMay, tvPartition } = require('../electron/guards.cjs') as {
  staysInOffice: (url: string, allowed: Array<string | undefined>) => boolean;
  externalUrl: (url: string) => string | null;
  pageMay: (permission: string, url: string, details: unknown, allowed: Array<string | undefined>) => boolean;
  tvPartition: (url: string, fingerprint?: string | null) => string;
};

const OFFICE = 'https://office.example.com';

test('the office\'s window stays in the office: the same scheme, host and port, not a look-alike', () => {
  for (const ok of [`${OFFICE}/`, `${OFFICE}/#tasks`, `${OFFICE}/api/x?y=1`, 'https://office.example.com:443/']) assert.equal(staysInOffice(ok, [OFFICE]), true, ok);
  for (const no of ['https://office.example.com.evil.net/', 'https://office.example.com@evil.net/', 'http://office.example.com/', 'https://office.example.com:8443/', 'https://evil.net/?https://office.example.com', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not a url'])
    assert.equal(staysInOffice(no, [OFFICE]), false, no);
  // An office at an address with a port, and the development page beside it.
  assert.equal(staysInOffice('https://10.0.0.5:4610/x', ['https://10.0.0.5:4610', undefined]), true);
  assert.equal(staysInOffice('https://10.0.0.5:46100/x', ['https://10.0.0.5:4610']), false);
  assert.equal(staysInOffice('http://localhost:5173/', [OFFICE, 'http://localhost:5173']), true);
});

test('only web and mail addresses are handed to the system to open', () => {
  assert.equal(externalUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(externalUrl('http://example.com'), 'http://example.com/');
  assert.equal(externalUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
  for (const no of ['file:///Applications/Calculator.app', 'file://attacker/share/x.exe', 'smb://attacker/share', 'search-ms:query=x', 'ms-msdt:/id', 'javascript:alert(1)', 'vscode://file/etc/passwd', 'ssh://host', '/etc/passwd', '', 'x'])
    assert.equal(externalUrl(no), null, no);
});

test('the office\'s page gets what the office uses, and of camera and microphone only the microphone; another page gets nothing', () => {
  const office = [OFFICE];
  assert.equal(pageMay('media', `${OFFICE}/`, { mediaTypes: ['audio'] }, office), true);
  assert.equal(pageMay('media', `${OFFICE}/`, { mediaTypes: ['audio', 'video'] }, office), false);
  assert.equal(pageMay('media', `${OFFICE}/`, { mediaTypes: ['video'] }, office), false);
  assert.equal(pageMay('media', `${OFFICE}/`, { mediaType: 'audio' }, office), true);
  assert.equal(pageMay('media', `${OFFICE}/`, { mediaType: 'video' }, office), false);
  assert.equal(pageMay('media', `${OFFICE}/`, {}, office), true, 'asking which sound devices there are');
  assert.equal(pageMay('media', `${OFFICE}/`, { mediaType: 'unknown' }, office), true, 'the same, as Electron words it');
  for (const yes of ['clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'fullscreen', 'speaker-selection']) assert.equal(pageMay(yes, `${OFFICE}/`, {}, office), true, yes);
  for (const no of ['geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture', 'openExternal', 'hid', 'serial', 'usb', 'idle-detection', 'window-management', 'unknown'])
    assert.equal(pageMay(no, `${OFFICE}/`, {}, office), false, no);
  for (const elsewhere of ['https://office.example.com.evil.net/', 'https://evil.net/', 'file:///x.html', ''])
    assert.equal(pageMay('media', elsewhere, { mediaTypes: ['audio'] }, office), false, elsewhere);
});

test('the TV keeps what it stored apart for each office', () => {
  const a = tvPartition('https://office.example.com', 'AA:BB');
  assert.match(a, /^persist:orch-tv-[0-9a-f]{16}$/);
  assert.equal(tvPartition('https://office.example.com/', 'AA:BB'), a, 'the same office is the same TV');
  assert.notEqual(tvPartition('https://other.example.com', 'AA:BB'), a);
  assert.notEqual(tvPartition('https://office.example.com', 'CC:DD'), a, 'another machine behind the same name is another office');
  assert.notEqual(tvPartition('https://office.example.com:4610', 'AA:BB'), a);
});
