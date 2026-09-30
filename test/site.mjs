#!/usr/bin/env node
/**
 * Build the guide site and check it: every page exists, every local link
 * resolves to a published file, every #anchor exists on its target page, and
 * nothing outside the allow-list was published.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteHref, slugify } from '../scripts/build-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}\n`);
  }
}

process.stdout.write('\nhelpers\n');
check('slug keeps Hangul and drops punctuation', slugify('3. 토큰 발급') === '3-토큰-발급');
check('slug matches GitHub for code spans', slugify('<code>models.yml</code>에 공급자 추가') === 'modelsyml에-공급자-추가');
check('sibling doc link maps to html', rewriteHref('gjc.md', 'ko') === 'gjc.html');
check('cross-language link keeps the anchor', rewriteHref('../en/guide.md#3-issue-a-token', 'ko') === '../en/guide.html#3-issue-a-token');
check('README link goes to the landing page', rewriteHref('../../README.ko.md', 'ko') === '../?lang=ko');
let threw = false;
try {
  rewriteHref('../../src/openai.js', 'en');
} catch {
  threw = true;
}
check('a link to an unpublished file fails the build', threw);

process.stdout.write('\nbuild\n');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-site.mjs')], { stdio: 'inherit' });

const published = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else published.push(path.relative(OUT, p));
  }
})(OUT);
const allowed = /^(index\.html|\.nojekyll|assets\/[\w.-]+|examples\/gjc-models\.yml|(ko|en)\/(guide|gjc)\.html)$/;
check('only allow-listed files are published', published.every((f) => allowed.test(f)), published.filter((f) => !allowed.test(f)).join(', '));
for (const p of ['index.html', 'ko/guide.html', 'ko/gjc.html', 'en/guide.html', 'en/gjc.html', 'examples/gjc-models.yml']) {
  check(`${p} exists`, published.includes(p));
}

process.stdout.write('\nlinks\n');
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = fs.readFileSync(path.join(OUT, file), 'utf8');
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
};
const broken = [];
for (const file of published.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(OUT, file), 'utf8');
  for (const [, raw] of html.matchAll(/\shref="([^"]+)"/g)) {
    const href = raw.replace(/&amp;/g, '&');
    if (/^https?:/.test(href)) continue;
    const [target, hash] = href.split('#');
    let resolved = target ? path.posix.normalize(path.posix.join(path.posix.dirname(file), target.split('?')[0])) : file;
    if (resolved === '.' || resolved.endsWith('/')) resolved = path.posix.join(resolved, 'index.html');
    if (!published.includes(resolved)) {
      broken.push(`${file} -> ${href}`);
      continue;
    }
    if (hash && resolved.endsWith('.html') && !idsOf(resolved).has(decodeURIComponent(hash))) broken.push(`${file} -> ${href} (anchor)`);
  }
}
check('every local link and anchor resolves', broken.length === 0, broken.join('; '));

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
