#!/usr/bin/env node
/**
 * Export the WordPress/Elementor site to static files for Cloudflare.
 *
 *   node scripts/export.mjs [--site https://avto2000.com]
 *
 * - renders every page in Yoast's page sitemap (+ a 404 page) from the local WP
 * - copies every /wp-content and /wp-includes file the pages and their CSS use,
 *   plus Elementor's lazily loaded JS/CSS chunks (not referenced in the HTML)
 * - makes URLs root-relative, except canonical/OpenGraph/JSON-LD/sitemaps, which
 *   must be absolute and point at --site
 * - removes WordPress-only head links (REST API, oEmbed, RSD, feeds, emoji)
 * - writes src/forms.generated.json for the Worker (CF7 + Elementor forms)
 *
 * Output: public/ (static assets) and src/forms.generated.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile, readFile, readdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfHostFonts, optimizeHtml } from './optimize.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : def;
};
const SRC = arg('src', 'http://avto2000-elementor.test').replace(/\/$/, '');
const SITE = arg('site', 'https://avto2000.com').replace(/\/$/, '');
const WP_ROOT = resolve(ROOT, arg('wp', '../avto2000-elementor'));
const OUT = join(ROOT, 'public');

const SRC_HOST = new URL(SRC).host;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const srcPlain = SRC;                                  // http://host
const srcJson = SRC.replace(/\//g, '\\/');            // http:\/\/host

const assets = new Set();
const stats = { pages: 0, assets: 0, chunks: 0, bytes: 0 };

async function get(url, { allow404 = false } = {}) {
	const res = await fetch(url, { redirect: 'manual' });
	if (!res.ok && !(allow404 && res.status === 404)) throw new Error(`${res.status} ${url}`);
	return res;
}

async function save(rel, data) {
	const file = join(OUT, rel);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, data);
	stats.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
}

/* collect /wp-content and /wp-includes paths mentioned anywhere in a text blob */
function collect(text) {
	const re = new RegExp(`(?:${esc(srcPlain)}|${esc(srcJson)})((?:\\\\?/)(?:wp-content|wp-includes)[^"'\\s)<>,]*)`, 'g');
	for (const m of text.matchAll(re)) {
		const p = m[1].replace(/\\\//g, '/').split(/[?#]/)[0];
		if (p && /\.[a-z0-9]+$/i.test(p)) assets.add(decodeURIComponent(p));
	}
}

/* absolute (SITE) for SEO-facing URLs, root-relative for everything else */
function rewriteHtml(html) {
	// 1. strip WordPress-only head entries
	html = html
		.replace(/<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*>\s*/g, '')
		.replace(/<link[^>]+(?:application\/json|application\/json\+oembed|text\/xml\+oembed|EditURI|wlwmanifest|shortlink)[^>]*>\s*/g, '')
		.replace(/<link[^>]+type=["']application\/rss\+xml["'][^>]*>\s*/g, '')
		.replace(/<meta name=["']generator["'][^>]*>\s*/g, '')
		.replace(/<script[^>]*>\s*window\._wpemojiSettings[\s\S]*?<\/script>\s*/g, '')
		.replace(/<script[^>]+id=["']wp-emoji-[^>]*><\/script>\s*/g, '')
		.replace(/<style[^>]+id=["']wp-emoji-styles-inline-css["'][\s\S]*?<\/style>\s*/g, '');

	// 2. SEO URLs must stay absolute: canonical, og/twitter, JSON-LD
	const toSite = (s) => s.split(srcPlain).join(SITE).split(srcJson).join(SITE.replace(/\//g, '\\/'));
	html = html
		.replace(/<link[^>]+rel=["']canonical["'][^>]*>/g, toSite)
		.replace(/<meta[^>]+(?:property|name)=["'](?:og:[^"']+|twitter:[^"']+)["'][^>]*>/g, toSite)
		.replace(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/g, toSite);

	// 3. everything else root-relative
	html = html
		.replace(new RegExp(`${esc(srcPlain)}(?=/)`, 'g'), '')
		.replace(new RegExp(`${esc(srcJson)}(?=\\\\/)`, 'g'), '')
		.split(srcPlain).join('/')
		.split(srcJson).join('\\/');
	return html;
}

async function exportPage(pathname, outFile, opts = {}) {
	const res = await get(SRC + pathname, opts);
	const html = await res.text();
	collect(html);
	await save(outFile, rewriteHtml(html));
	stats.pages++;
}

/* CSS: follow url(...) and @import so backgrounds and fonts come along */
async function exportCss(path, text) {
	const base = new URL(SRC + path);
	for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+['"]([^'"]+)['"]/g)) {
		const ref = (m[2] || m[3] || '').trim();
		if (!ref || ref.startsWith('data:') || ref.startsWith('#')) continue;
		const u = new URL(ref, base);
		if (u.host !== SRC_HOST) continue;
		const p = decodeURIComponent(u.pathname);
		if (!assets.has(p)) { assets.add(p); pending.push(p); }
	}
	return text.split(srcPlain).join('');
}

const pending = [];
async function exportAssets() {
	const done = new Set();
	pending.push(...assets);
	while (pending.length) {
		const p = pending.shift();
		if (done.has(p)) continue;
		done.add(p);
		const res = await fetch(SRC + encodeURI(p));
		if (!res.ok) { console.warn(`  ! ${res.status} ${p}`); continue; }
		if (p.endsWith('.css')) {
			await save(p, await exportCss(p, await res.text()));
		} else {
			await save(p, new Uint8Array(await res.arrayBuffer()));
		}
		stats.assets++;
	}
}

/* Elementor loads widget handlers and some CSS on demand from its assets dir;
 * those URLs never appear in the HTML, so copy the minified sets from disk. */
async function copyDir(rel, test) {
	const dir = join(WP_ROOT, rel);
	let entries;
	try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const r = `${rel}/${e.name}`;
		if (e.isDirectory()) { await copyDir(r, test); continue; }
		if (!test(e.name)) continue;
		const dest = join(OUT, r);
		if (await stat(dest).catch(() => null)) continue;
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(join(WP_ROOT, r), dest);
		stats.chunks++;
	}
}

/* ------------------------------------------------------------------ run -- */
console.log(`Export ${SRC} -> public/  (canonical: ${SITE})`);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// pages from Yoast's sitemap
const sitemap = await (await get(`${SRC}/page-sitemap.xml`)).text();
const pages = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
	.map((m) => new URL(m[1]).pathname)
	.filter((p) => !p.startsWith('/wp-content/'));
for (const p of pages) {
	await exportPage(p, p === '/' ? 'index.html' : `${p.replace(/^\/|\/$/g, '')}/index.html`);
	console.log(`  page ${p}`);
}
await exportPage('/this-page-does-not-exist-404/', '404.html', { allow404: true });

// sitemaps + robots, with absolute SITE urls
for (const f of ['sitemap_index.xml', 'page-sitemap.xml', 'main-sitemap.xsl']) {
	const res = await fetch(`${SRC}/${f}`);
	if (!res.ok) { console.warn(`  ! ${res.status} ${f}`); continue; }
	let text = await res.text();
	collect(text);
	text = text.split(srcPlain).join(SITE);
	await save(f, text);
}

await exportAssets();
await copyDir('wp-content/plugins/elementor/assets/js', (n) => n.endsWith('.min.js'));
await copyDir('wp-content/plugins/elementor-pro/assets/js', (n) => n.endsWith('.min.js'));
await copyDir('wp-content/plugins/elementor/assets/css', (n) => n.endsWith('.min.css'));
await copyDir('wp-content/plugins/elementor-pro/assets/css', (n) => n.endsWith('.min.css'));
await copyDir('wp-content/plugins/elementor/assets/lib', (n) => /\.(min\.js|min\.css|woff2?|ttf|svg|png|gif)$/.test(n));

// performance pass over every exported page (see scripts/optimize.mjs)
const font = await selfHostFonts(OUT);
for (const f of [...pages.map((p) => (p === '/' ? 'index.html' : `${p.replace(/^\/|\/$/g, '')}/index.html`)), '404.html']) {
	const file = join(OUT, f);
	await writeFile(file, await optimizeHtml(await readFile(file, 'utf8'), { OUT, WP_ROOT, font }));
}
console.log('  optimized: inlined CSS, self-hosted font, hero preload, deferred jQuery');

// cache + security headers for Workers static assets
await save('_headers', `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN

/wp-content/*
  Cache-Control: public, max-age=31536000, immutable

/wp-includes/*
  Cache-Control: public, max-age=31536000, immutable

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
`);

// form definitions for the Worker
const dump = execFileSync('wp', [`--path=${WP_ROOT}`, 'eval-file', join(ROOT, 'scripts/forms-dump.php')],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
// WP_DEBUG notices can trail the JSON on stdout: keep the top-level object only
const forms = JSON.parse(dump.slice(dump.indexOf('{'), dump.indexOf('\n}') + 2));
for (const id of Object.keys(forms.cf7)) {
	const r = await fetch(`${SRC}/wp-json/contact-form-7/v1/contact-forms/${id}/feedback/schema`);
	forms.cf7[id].schema = r.ok ? await r.json() : null;
}
/* robots.txt follows WordPress's "search engine visibility" setting */
await save('robots.txt', forms.site.public
	? `User-agent: *\nDisallow:\n\nSitemap: ${SITE}/sitemap_index.xml\n`
	: 'User-agent: *\nDisallow: /\n');

await writeFile(join(ROOT, 'src/forms.generated.json'), JSON.stringify(forms, null, '\t') + '\n');

console.log(`Done: ${stats.pages} pages, ${stats.assets} referenced assets, ${stats.chunks} Elementor chunks, ` +
	`${Object.keys(forms.cf7).length} CF7 + ${Object.keys(forms.elementor).length} Elementor forms.`);
