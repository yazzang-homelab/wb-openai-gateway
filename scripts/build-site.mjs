#!/usr/bin/env node
/**
 * Build the static guide site into _site/.
 *
 *   site/index.html + site/assets/*   copied as-is (bilingual landing page)
 *   docs/<lang>/<doc>.md              rendered to _site/<lang>/<doc>.html
 *   examples/gjc-models.yml           copied so the site can link it
 *
 * Only these inputs are published; the gateway source, tests and any runtime
 * data never reach the Pages artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const LANGS = ['ko', 'en'];
const DOCS = ['guide', 'gjc'];
const EXAMPLES = ['gjc-models.yml'];

const LABELS = {
  ko: { guide: '가이드', gjc: 'GJC 별첨', toc: '목차', home: '홈', other: 'EN', footer: '비공식 가이드' },
  en: { guide: 'Guide', gjc: 'GJC appendix', toc: 'CONTENTS', home: 'Home', other: '한국어', footer: 'unofficial guide' }
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** GitHub-compatible heading slug, so `doc.md#section` links work on both GitHub and the site. */
export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Map a Markdown link target onto the published site layout. */
export function rewriteHref(href, lang) {
  if (/^[a-z]+:|^#/i.test(href)) return href;
  const [target, hash = ''] = href.split('#');
  const suffix = hash ? `#${hash}` : '';
  const doc = /^(?:\.\.\/(ko|en)\/)?(guide|gjc)\.md$/.exec(target);
  if (doc) return `${doc[1] ? `../${doc[1]}/` : ''}${doc[2]}.html${suffix}`;
  if (target === '../../README.md') return `../?lang=en${suffix}`;
  if (target === '../../README.ko.md') return `../?lang=ko${suffix}`;
  const example = /^\.\.\/\.\.\/examples\/([\w.-]+)$/.exec(target);
  if (example && EXAMPLES.includes(example[1])) return `../examples/${example[1]}`;
  throw new Error(`docs/${lang}: unpublished link target "${href}"`);
}

function render(markdown, lang) {
  const headings = [];
  const seen = new Map();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const base = slugify(html);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        if (depth === 2) headings.push({ id, html });
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(rewriteHref(href, lang))}"${t}>${text}</a>`;
      }
    }
  });
  const body = marked.parse(markdown);
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? 'wb-openai-gateway';
  return { body, headings, title };
}

function page({ lang, doc, body, headings, title }) {
  const L = LABELS[lang];
  const other = lang === 'ko' ? 'en' : 'ko';
  const nav = DOCS.map(
    (d) => `<a href="${d}.html"${d === doc ? ' aria-current="page"' : ''}>${L[d]}</a>`
  ).join('\n          ');
  const toc = headings.map((h) => `<a href="#${h.id}">${h.html}</a>`).join('\n        ');
  return `<!doctype html>
<html lang="${lang}" data-lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#09090b" />
    <title>${escapeHtml(title)} · wb-openai-gateway</title>
    <link rel="icon" type="image/svg+xml" href="../assets/favicon.svg" />
    <link rel="stylesheet" href="../assets/site.css" />
    <script src="../assets/site.js" defer></script>
  </head>
  <body>
    <header class="site-header">
      <div class="container header-inner">
        <a class="brand" href="../?lang=${lang}"><span class="brand-icon" aria-hidden="true">&gt;_</span>WB-GATEWAY<small>/v1</small></a>
        <nav class="nav" aria-label="Docs">
          ${nav}
        </nav>
        <div class="lang-switch"><a href="../${other}/${doc}.html" lang="${other}">${L.other}</a></div>
      </div>
    </header>
    <main class="container doc">
      <aside class="toc" aria-label="${L.toc}">
        <p>${L.toc}</p>
        ${toc}
      </aside>
      <article class="prose">
${body}
      </article>
    </main>
    <footer class="container site-footer">
      <span>wb-openai-gateway · ${L.footer}</span>
      <span><a href="../?lang=${lang}">${L.home}</a><a href="https://github.com/yazzang-homelab/wb-openai-gateway">GitHub</a><a href="https://github.com/dbc-hbin/wb-agent-gateway">upstream: dbc-hbin</a></span>
    </footer>
  </body>
</html>
`;
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  copy(path.join(ROOT, 'site/index.html'), path.join(OUT, 'index.html'));
  for (const asset of fs.readdirSync(path.join(ROOT, 'site/assets'))) {
    copy(path.join(ROOT, 'site/assets', asset), path.join(OUT, 'assets', asset));
  }
  for (const example of EXAMPLES) {
    copy(path.join(ROOT, 'examples', example), path.join(OUT, 'examples', example));
  }
  let pages = 0;
  for (const lang of LANGS) {
    for (const doc of DOCS) {
      const md = fs.readFileSync(path.join(ROOT, 'docs', lang, `${doc}.md`), 'utf8');
      const rendered = render(md, lang);
      fs.mkdirSync(path.join(OUT, lang), { recursive: true });
      fs.writeFileSync(path.join(OUT, lang, `${doc}.html`), page({ lang, doc, ...rendered }));
      pages++;
    }
  }
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  process.stdout.write(`built ${pages} doc pages + landing into ${path.relative(ROOT, OUT)}/\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
