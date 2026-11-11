import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryScripts, servedPageDiffers } from '../src/lib/page-version.ts';

const page = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script><link rel="stylesheet" href="/assets/index-CgwwGX1i.css"></head><body><div id="root"></div></body></html>`;

test('a window that is a version behind is told from one that is current', () => {
  const mine = ['/assets/index-TSDzxNea.js'];
  assert.equal(servedPageDiffers(mine, page('/assets/index-TSDzxNea.js')), false, 'the office still serves what this window runs');
  assert.equal(servedPageDiffers(mine, page('/assets/index-9fQx01Lm.js')), true, 'the office was updated: its page starts with another script');
});

test('what is not the office\'s page says nothing about versions: no reload is offered for a network problem', () => {
  const mine = ['/assets/index-TSDzxNea.js'];
  assert.equal(servedPageDiffers(mine, ''), false);
  assert.equal(servedPageDiffers(mine, '<html><body><h1>502 Bad Gateway</h1></body></html>'), false, 'a proxy\'s error page');
  assert.equal(servedPageDiffers(mine, '{"error":"not found"}'), false);
  assert.equal(servedPageDiffers([], page('/assets/index-9fQx01Lm.js')), false, 'a page that does not know its own scripts (a development server)');
});

test('the scripts a page was started with are read from the page itself, as paths', () => {
  const doc = { querySelectorAll: () => [{ src: 'https://office.example.com/assets/index-TSDzxNea.js' }, { src: '/assets/extra-1.js?x=1' }, { src: '' }] } as unknown as Pick<Document, 'querySelectorAll'>;
  assert.deepEqual(entryScripts(doc), ['/assets/index-TSDzxNea.js', '/assets/extra-1.js']);
});
