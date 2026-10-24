/**
 * Performance pass over the exported HTML. WordPress/Elementor stay untouched;
 * only the published copy changes.
 *
 *  1. Inline every same-origin stylesheet in place (cascade order preserved), so
 *     first paint needs no CSS round trips. url()s are made root-absolute.
 *  2. Self-host the Google font (Archivo, latin + latin-ext, woff2), inline its
 *     @font-face and preload the latin file.
 *  3. Move jQuery from <head> to the footer script block (nothing in <head>
 *     depends on it), so it no longer blocks rendering.
 *  4. Hero backgrounds above the first <h2>: serve WordPress's smaller copies on
 *     phone/tablet and preload the right one with fetchpriority=high.
 *  5. Images: correct `sizes` for car cards, lazy-load everything below the hero.
 *  6. Drop the leftover emoji loader.
 */
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* ---------------------------------------------------------------- fonts -- */
export async function selfHostFonts(OUT, family = 'Archivo', weights = '400;600;700;800') {
	const api = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weights}&display=swap`;
	let css = await (await fetch(api, { headers: { 'User-Agent': CHROME_UA } })).text();
	// keep latin + latin-ext only (the site is English with Slovene names)
	const blocks = css.split(/(?=\/\* [\w-]+ \*\/)/).filter((b) => /^\/\* (latin|latin-ext) \*\//.test(b));
	css = blocks.join('');
	const files = new Map();
	for (const block of blocks) {
		const subset = /^\/\* ([\w-]+) \*\//.exec(block)[1];
		const remote = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(block)?.[1];
		if (!remote || files.has(remote)) continue;
		const local = `/fonts/${family.toLowerCase()}-${subset}.woff2`;   // variable font: one file per subset
		await mkdir(join(OUT, 'fonts'), { recursive: true });
		await writeFile(join(OUT, local), new Uint8Array(await (await fetch(remote)).arrayBuffer()));
		files.set(remote, local);
	}
	for (const [remote, local] of files) css = css.split(remote).join(local);
	// the latin file is the one every page needs first
	const latin = /\/\* latin \*\/[^}]*?url\(([^)]+)\)/.exec(css)?.[1];
	/* Metric-matched fallback, so swapping Arial -> Archivo moves nothing (CLS).
	 * Numbers from scripts/font-metrics.py (Archivo 400/800 vs Arial / Arial Bold). */
	css += `@font-face{font-family:"${family} Fallback";src:local("Arial"),local("ArialMT");font-weight:100 599;` +
		'size-adjust:98.17%;ascent-override:89.44%;descent-override:21.39%;line-gap-override:0%}' +
		`@font-face{font-family:"${family} Fallback";src:local("Arial Bold"),local("Arial-BoldMT");font-weight:600 900;` +
		'size-adjust:102.91%;ascent-override:85.32%;descent-override:20.41%;line-gap-override:0%}';
	return { css: minify(css), preload: latin, family };
}

/* ------------------------------------------------------------------ css -- */
function minify(css) {
	return css
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\s+/g, ' ')
		.replace(/\s*([{}:;,>])\s*/g, '$1')
		.replace(/;}/g, '}')
		.trim();
}

/** make every url() in a stylesheet root-absolute, relative to where it lived */
function absolutize(css, cssPath) {
	const base = posix.dirname(cssPath) + '/';
	return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, ref) => {
		if (/^(data:|https?:|\/|#)/.test(ref)) return whole;
		return `url(${q}${posix.normalize(base + ref)}${q})`;
	});
}

/* --------------------------------------------------------------- images -- */
/** WordPress size variants on disk: name-1536x652.webp etc. */
async function variants(WP_ROOT, src) {
	const m = /^(.*)\.(webp|jpe?g|png|avif)$/i.exec(src);
	if (!m) return [];
	const out = [];
	for (const w of [768, 1024, 1536, 2048]) {
		const dir = join(WP_ROOT, posix.dirname(src));
		const { readdir } = await import('node:fs/promises');
		const base = posix.basename(m[1]);
		const hit = (await readdir(dir)).find((f) => f.startsWith(`${base}-${w}x`) && f.endsWith(`.${m[2]}`));
		if (hit) out.push({ w, path: `${posix.dirname(src)}/${hit}` });
	}
	return out;
}

/* ----------------------------------------------------------------- page -- */
/* SVG <img> without dimensions: take them from the file's width/height (CLS) */
const svgDims = new Map();
let OUT_DIR = '';
function sizeSvg(img) {
	if (/\swidth=/.test(img)) return img;
	const src = /src=["'](\/[^"']+\.svg)["']/.exec(img)?.[1];
	if (!src) return img;
	const d = svgDims.get(src);
	return d ? img.replace('<img', `<img width="${d.w}" height="${d.h}"`) : img;
}
async function loadSvgDims(html) {
	for (const m of html.matchAll(/<img[^>]+src=["'](\/[^"']+\.svg)["']/g)) {
		if (svgDims.has(m[1])) continue;
		try {
			const svg = await readFile(join(OUT_DIR, m[1]), 'utf8');
			const w = /<svg[^>]*\swidth=["']([\d.]+)/.exec(svg)?.[1];
			const h = /<svg[^>]*\sheight=["']([\d.]+)/.exec(svg)?.[1];
			if (w && h) svgDims.set(m[1], { w, h });
		} catch {}
	}
}

export async function optimizeHtml(html, { OUT, WP_ROOT, font }) {
	OUT_DIR = OUT;
	await loadSvgDims(html);
	// Elementor's tel pattern is invalid under the `v` regex flag Chrome uses for
	// pattern="" (unescaped ( ) and a "*-=" range): console error on every page.
	// Same accepted characters, written so the v flag parses it.
	html = html.replace(/pattern="\[0-9\(\)#(&amp;|&)\+\*-=\.\]\+"/g, 'pattern="[0-9\\(\\)#$1+*=.\\-]+"');

	// flatpickr is only needed by Elementor date fields that do NOT use the native
	// picker; when every date field is native, drop its JS and CSS (legacy JS audit)
	if (!/elementor-date-field(?![^"]*elementor-use-native)/.test(html)) {
		html = html
			.replace(/<script[^>]+id=["']flatpickr-js["'][^>]*><\/script>\s*/g, '')
			.replace(/<link[^>]+id=["']flatpickr-css["'][^>]*>\s*/g, '');
	}

	// 6. emoji leftovers
	html = html
		.replace(/<script[^>]+id=["']wp-emoji-settings["'][^>]*>[\s\S]*?<\/script>\s*/g, '')
		.replace(/<script type=["']module["']>[\s\S]*?wp-emoji[\s\S]*?<\/script>\s*/g, '');

	// 2. fonts: drop Google links, inline self-hosted faces + preload
	html = html
		.replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g, '')
		.replace(/<link[^>]+rel=["'](?:preconnect|dns-prefetch)["'][^>]+fonts\.[^>]*>\s*/g, '');
	const head = [`<link rel="preload" href="${font.preload}" as="font" type="font/woff2" crossorigin>`,
		`<style id="fonts-inline">${font.css}</style>`];

	// 1. inline stylesheets in place
	const links = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)];
	let allCss = '';
	for (const [tag] of links) {
		const href = /href=["']([^"']+)["']/.exec(tag)?.[1] ?? '';
		const media = /media=["']([^"']+)["']/.exec(tag)?.[1] ?? 'all';
		if (!href.startsWith('/') || href.startsWith('//') || media === 'print') continue;
		const path = href.split(/[?#]/)[0];
		let css;
		try { css = await readFile(join(OUT, path), 'utf8'); } catch { continue; }
		css = minify(absolutize(css.replace(/\/\*# sourceMappingURL=[^*]*\*\//g, ''), path));
		allCss += css;
		if (media !== 'all' && media !== 'screen') css = `@media ${media}{${css}}`;   // e.g. base-mobile.css
		const id = /id=["']([^"']+)["']/.exec(tag)?.[1];
		html = html.replace(tag, `<style${id ? ` id="${id}"` : ''}>${css}</style>`);
	}

	// fallback family next to every "Archivo" in the page CSS (not in the @font-face block)
	const fam = font.family;
	html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (whole, attrs, css) => {
		if (/id=["']fonts-inline["']/.test(attrs)) return whole;
		return `<style${attrs}>${css.replace(new RegExp(`(["'])${fam}\\1(?!\\s*,\\s*["']${fam} Fallback)`, 'g'),
			`"${fam}","${fam} Fallback"`)}</style>`;
	});

	// Google Maps embed -> click-to-load facade. The iframe pulls ~1 MB of Google
	// JS, fonts and tiles with short cache lifetimes; load it only when asked for.
	if (/<iframe[^>]+maps\.google\.com/.test(html)) {
		html = html.replace(/<iframe\b[^>]*?src="(https:\/\/maps\.google\.com\/maps\?[^"]+)"[^>]*?title="([^"]*)"[^>]*><\/iframe>/g,
			(whole, src, title) => {
				const q = /[?&](?:amp;|#038;)?q=([^&]+)/.exec(src.replace(/&#038;/g, '&'))?.[1] ?? encodeURIComponent(title);
				return `<div class="av-map" data-src="${src}" data-title="${title}">` +
					'<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>' +
					`<p class="av-map__place">${title}</p><div class="av-map__actions">` +
					'<button type="button" class="av-map__load">Show map</button>' +
					`<a href="https://www.google.com/maps/search/?api=1&amp;query=${q}" target="_blank" rel="noopener">Open in Google Maps</a></div></div>`;
			});
		// the widget's height rules target `iframe`; let them size the facade too
		html = html.replace(/(\.elementor-(?:element-[0-9a-f]+|widget-google_maps) )iframe\{height:/g, '$1:is(iframe,.av-map){height:');
		html = html.replace('</head>', '<style id="av-map">' + minify(`
			.av-map{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;width:100%;
				padding:24px;line-height:1.4;text-align:center;color:var(--e-global-color-primary);background:var(--e-global-color-photo)}
			.av-map__place{margin:0;font-size:20px;font-weight:700}
			.av-map__actions{display:flex;flex-wrap:wrap;justify-content:center;gap:12px}
			.av-map__load,.av-map__actions a{display:inline-flex;align-items:center;min-height:44px;padding:10px 20px;
				border:2px solid var(--e-global-color-primary);border-radius:6px;font:inherit;font-size:16px;font-weight:600;
				line-height:1.2;cursor:pointer;text-decoration:none;transition:background-color .18s ease-out,color .18s ease-out}
			.av-map__load,.av-map__load:focus{color:var(--e-global-color-surface);background:var(--e-global-color-primary)}
			.av-map__load:hover{color:var(--e-global-color-surface);background:var(--e-global-color-secondary);border-color:var(--e-global-color-secondary)}
			.av-map__actions a{color:var(--e-global-color-primary);background:var(--e-global-color-surface)}
			.av-map__actions a:hover{color:var(--e-global-color-surface);background:var(--e-global-color-primary)}
			.av-map :focus-visible{outline:3px solid var(--e-global-color-primary);outline-offset:2px}`) + '</style></head>');
		const loader = `document.addEventListener('click',function(e){var b=e.target.closest('.av-map__load');if(!b)return;` +
			`var m=b.closest('.av-map'),f=document.createElement('iframe');f.src=m.dataset.src.replace(/&#038;/g,'&');` +
			`f.title=m.dataset.title;f.setAttribute('aria-label',m.dataset.title);f.style.border='0';f.style.width='100%';` +
			`m.replaceWith(f);f.focus();});`;
		html = html.replace('</body>', `<script defer src="data:text/javascript;base64,${Buffer.from(loader).toString('base64')}"></script></body>`);
	}

	// 4. hero background above the first <h2>
	const h2 = html.search(/<h2[\s>]/);
	const preloads = [];
	const overrides = [];
	const seen = new Set();
	for (const m of allCss.matchAll(/([^{}@]+)\{[^{}]*background-image:url\(["']?(\/wp-content\/uploads\/[^"')]+)["']?\)[^{}]*\}/g)) {
		const [, selector, src] = m;
		const id = /elementor-element-([0-9a-f]{6,8})/.exec(selector)?.[1];
		if (!id || seen.has(src)) continue;
		const at = html.indexOf(`data-id="${id}"`);
		if (at < 0 || (h2 > -1 && at > h2)) continue;
		seen.add(src);
		const v = await variants(WP_ROOT, src);
		const phone = v.find((x) => x.w === 1536) ?? v.at(-1);
		const tablet = v.find((x) => x.w === 2048) ?? v.at(-1);
		for (const x of [phone, tablet]) {
			if (!x) continue;
			const dest = join(OUT, x.path);
			if (!(await stat(dest).catch(() => null))) {
				await mkdir(dirname(dest), { recursive: true });
				await copyFile(join(WP_ROOT, x.path), dest);
			}
		}
		if (phone) {
			overrides.push(`@media (max-width:767px){${selector}{background-image:url(${phone.path})}}`);
			preloads.push(`<link rel="preload" as="image" href="${phone.path}" media="(max-width: 767px)" fetchpriority="high">`);
		}
		if (tablet) {
			overrides.push(`@media (min-width:768px) and (max-width:1024px){${selector}{background-image:url(${tablet.path})}}`);
			preloads.push(`<link rel="preload" as="image" href="${tablet.path}" media="(min-width: 768px) and (max-width: 1024px)" fetchpriority="high">`);
		}
		preloads.push(`<link rel="preload" as="image" href="${src}" media="(min-width: 1025px)" fetchpriority="high">`);
	}
	if (overrides.length) {
		// after every inlined stylesheet, so the overrides win at equal specificity
		html = html.replace('</head>', `<style id="hero-responsive">${overrides.join('')}</style></head>`);
	}

	html = html.replace(/<head>/, `<head>${preloads.join('')}${head.join('')}`);

	// charset must stay within the first 1024 bytes: hoist it back to the top
	const charset = /<meta charset=["'][^"']+["'][^>]*>/.exec(html)?.[0];
	if (charset) html = html.replace(charset, '').replace('<head>', `<head>${charset}`);

	// 3. jQuery out of <head>, in front of the first footer script
	const jq = [...html.slice(0, html.indexOf('</head>')).matchAll(/<script[^>]+id=["']jquery-(?:core|migrate)-js["'][^>]*><\/script>\s*/g)].map((m) => m[0]);
	if (jq.length) {
		for (const s of jq) html = html.replace(s, '');
		const body = html.indexOf('<body');
		const first = html.indexOf('<script', body);
		html = html.slice(0, first) + jq.join('') + html.slice(first);
	}

	// 3b. defer every footer script, keeping execution order. External scripts get
	// `defer`; inline snippets (config objects, wp.i18n setup) become deferred
	// data: scripts so they still run in sequence between the files they sit between.
	const bodyAt = html.indexOf('<body');
	html = html.slice(0, bodyAt) + html.slice(bodyAt).replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (whole, attrs, code) => {
		if (/type=["'](?:application\/(?:ld\+)?json|speculationrules|module|text\/template)["']/.test(attrs)) return whole;
		if (/\bsrc=/.test(attrs)) return /\b(?:defer|async)\b/.test(attrs) ? whole : `<script defer${attrs}></script>`;
		if (!code.trim()) return whole;
		const id = /\sid=["'][^"']+["']/.exec(attrs)?.[0] ?? '';
		return `<script defer${id} src="data:text/javascript;base64,${Buffer.from(code).toString('base64')}"></script>`;
	});

	// skip link: Hello points it at #content, which Elementor pages do not have
	if (!/\sid=["']content["']/.test(html)) {
		html = html.replace(/(<\/header>\s*<(?:div|main|section)\b)/, '$1 id="content" tabindex="-1"');
	}

	// 5. images
	const heroPreloaded = preloads.length > 0;
	html = html.replace(/<article[^>]*class=["'][^"']*\bav-card\b[\s\S]*?<\/article>/g, (card) =>
		card.replace(/sizes=["'][^"']*["']/, 'sizes="(max-width: 767px) calc(100vw - 40px), (max-width: 1024px) calc(50vw - 40px), 380px"'));
	let eagerLeft = heroPreloaded ? 0 : 1;   // only the likely LCP image; lazy images in view still load at once
	const headerEnd = html.search(/<\/header>/);
	html = html.replace(/<img\b[^>]*>/g, (img, offset) => {
		img = sizeSvg(img);
		if (offset < headerEnd) return img.replace(/\sloading=["']lazy["']/, '');   // header logo: eager
		if (eagerLeft > 0) {                                      // likely LCP: eager (+ high on the first)
			const first = true;
			eagerLeft--;
			img = img.replace(/\sloading=["']lazy["']/, '');
			return first ? img : img.replace(/\sfetchpriority=["']high["']/, '');
		}
		img = img.replace(/\sfetchpriority=["']high["']/, '');
		return /\sloading=/.test(img) ? img : img.replace('<img', '<img loading="lazy"');
	});

	return html;
}
