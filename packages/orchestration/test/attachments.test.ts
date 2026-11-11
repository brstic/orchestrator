import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isImage, mimeOf, safeName } from '../src/attachments.ts';
import { findBrowserMcp } from '../../execution/src/claude.ts';

test('a file name from outside is made safe to stand in a folder', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\shot 1.png'), 'shot 1.png');
  assert.equal(safeName('.env'), 'env');
  assert.equal(safeName('...hidden'), 'hidden');
  assert.equal(safeName('a<b>:"c"|d?.txt'), 'abcd.txt');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('/'), 'file');
  assert.equal(safeName('x'.repeat(300) + '.png').length, 120);
  assert.equal(safeName('snimak ekrana — greška.png'), 'snimak ekrana — greška.png');
});

test('what a file is, is told from its name; only plain picture formats count as images', () => {
  assert.equal(mimeOf('Shot.PNG'), 'image/png');
  assert.equal(mimeOf('a.jpeg'), 'image/jpeg');
  assert.equal(mimeOf('spec.pdf'), 'application/pdf');
  assert.equal(mimeOf('noextension'), 'application/octet-stream');
  assert.equal(mimeOf('weird.xyz'), 'application/octet-stream');
  for (const yes of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(isImage(yes), true);
  // An SVG can carry script and an HTML page is one: neither is ever shown as a picture.
  for (const no of ['image/svg+xml', 'text/html', 'application/pdf']) assert.equal(isImage(no), false);
});

test('a browser for employees is found where somebody installed it, and nowhere else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-browser-'));
  try {
    assert.equal(findBrowserMcp([dir], {}), null, 'nothing installed');
    const pkg = path.join(dir, 'browser', 'node_modules', '@playwright', 'mcp');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), '// stand-in\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.0.83' }));
    const found = findBrowserMcp([path.join(dir, 'nowhere'), dir], { ORCH_BROWSER_CHROME: 'none' })!;
    assert.equal(found.version, '0.0.83');
    assert.equal(found.engine, 'chromium');
    assert.deepEqual(found.args, [path.join(pkg, 'cli.js'), '--headless', '--isolated', '--file-paths', 'absolute']);
    assert.equal(found.command, process.execPath);
    // The machine's own Chrome is used when it has one.
    const chrome = findBrowserMcp([dir], { ORCH_BROWSER_CHROME: '/usr/bin/google-chrome' })!;
    assert.deepEqual(chrome.args.slice(-2), ['--browser', 'chrome']);
    assert.equal(chrome.engine, 'chrome');
    // Named outright, it wins over the usual places; a path that is not a file is no browser.
    const own = path.join(dir, 'own-cli.js');
    fs.writeFileSync(own, '');
    assert.equal(findBrowserMcp([dir], { ORCH_BROWSER_MCP: own, ORCH_BROWSER_CHROME: 'none' })!.args[0], own);
    assert.equal(findBrowserMcp([], { ORCH_BROWSER_MCP: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
