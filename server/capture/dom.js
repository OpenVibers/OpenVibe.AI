'use strict';
/**
 * What a capture records about a page, measured in the page.
 *
 * The DOM facts are the raw material a text model reads: the fonts and the type scale, the palette with how
 * much of the page each colour covers, the spacing, radii and shadows, the grid and container widths, the
 * navigation pattern, the heading outline, the button and link words, and a component inventory. Nothing is a
 * screenshot guess; every number is computed from the live document.
 *
 * The Expert extras are here too: axe-core's findings, the LCP/CLS/INP a real visit measured, and the timing
 * script is installed before the first byte (addInitScript) so the largest paint is not missed.
 */

/** Installed before navigation: the paint, layout shift and interaction readings an Expert capture reports. */
const METRICS_INIT = `(() => {
  if (window.__ovMetrics) return;
  const m = window.__ovMetrics = { lcp: null, cls: 0, inp: null, long_tasks: 0, poor_interactions: 0, shifts: [] };
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) m.lcp = { ms: Math.round(e.startTime), size: e.size || 0, element: e.element ? (e.element.tagName || '') : null }; }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { if (e.hadRecentInput) continue; m.cls += e.value || 0; if (m.shifts.length < 8 && e.value) m.shifts.push({ value: Math.round(e.value * 1000) / 1000, at: Math.round(e.startTime) }); } }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { m.long_tasks++; if (e.duration > 200) m.poor_interactions++; } }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { if (e.duration == null) continue; if (m.inp == null || e.duration > m.inp.ms) m.inp = { ms: Math.round(e.duration), name: e.name || null }; } }).observe({ type: 'event', buffered: true });
  } catch (e) {}
  addEventListener('pagehide', () => {}, { once: true });
})();`;

/** Read after the page has settled: the DOM facts a text model uses. */
function collectDom(limit = 4000) {
    const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    const many = new Map();
    const add = (map, key, n = 1) => { if (key == null || key === '') return; map.set(key, (map.get(key) || 0) + n); };
    const top = (map, n, total) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count, share: total ? Math.round((count / total) * 1000) / 1000 : 0 }));
    const rgb = (v) => {
        const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(v || '').trim());
        if (!m) return null;
        if (m[4] != null && Number(m[4]) === 0) return null;
        return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
    };
    const px = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) && n !== 0 ? `${Math.round(n * 10) / 10}px` : null;
    };
    const all = [...document.querySelectorAll('body *')].slice(0, limit);
    const total = all.length || 1;
    const fonts = new Map(); const sizes = new Map(); const weights = new Map(); const lines = new Map();
    const colours = new Map(); const backgrounds = new Map(); const borders = new Map();
    const gaps = new Map(); const pads = new Map(); const margins = new Map(); const radii = new Map(); const shadows = new Map(); const widths = new Map();
    let grid = 0; let flex = 0; let images = 0; let svgs = 0; let videos = 0; let inputs = 0; let forms = 0; let tables = 0; let dialogs = 0; let cards = 0; let canvases = 0;
    const buttons = []; const links = []; const headings = []; const navs = [];
    for (const el of all) {
        const cs = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        add(fonts, clean(cs.fontFamily, 120));
        add(sizes, px(cs.fontSize)); add(weights, clean(cs.fontWeight, 20)); add(lines, px(cs.lineHeight));
        const fg = rgb(cs.color); if (fg) add(colours, fg);
        const bg = rgb(cs.backgroundColor); if (bg) add(backgrounds, bg);
        const border = rgb(cs.borderTopColor); if (border && parseFloat(cs.borderTopWidth) > 0) add(borders, border);
        add(gaps, px(cs.gap)); add(radii, px(cs.borderTopLeftRadius));
        add(shadows, clean(cs.boxShadow, 160)); add(widths, px(cs.maxWidth));
        add(pads, px(cs.paddingTop)); add(pads, px(cs.paddingLeft));
        add(margins, px(cs.marginTop)); add(margins, px(cs.marginBottom));
        if (cs.display === 'grid') grid++; else if (cs.display.includes('flex')) flex++;
        if (tag === 'img') images++; else if (tag === 'svg') svgs++; else if (tag === 'video') videos++;
        else if (tag === 'input' || tag === 'select' || tag === 'textarea') inputs++; else if (tag === 'form') forms++;
        else if (tag === 'table') tables++; else if (tag === 'dialog') dialogs++; else if (tag === 'canvas') canvases++;
        else if (/card|tile|panel/i.test(String(el.className || ''))) cards++;
        if (tag === 'button' || (tag === 'input' && /^(button|submit)$/i.test(el.type)) || el.getAttribute('role') === 'button') {
            if (buttons.length < 60) buttons.push({ text: clean(el.innerText || el.value || el.getAttribute('aria-label'), 120), tag, name: clean(el.getAttribute('aria-label') || el.getAttribute('title'), 120) || null, disabled: Boolean(el.disabled) });
        }
        if (tag === 'a' && links.length < 120) links.push({ text: clean(el.innerText, 100), href: clean(el.getAttribute('href'), 300) });
        if (/^h[1-6]$/.test(tag) && headings.length < 60) headings.push({ level: Number(tag[1]), text: clean(el.innerText, 160) });
        if (tag === 'nav' || (!navs.length && el.getAttribute('role') === 'navigation')) navs.push(tag);
    }
    const body = document.body;
    const header = document.querySelector('header') || document.querySelector('nav') || document.querySelector('[role="banner"]');
    const headerCs = header ? getComputedStyle(header) : null;
    const menuButton = [...document.querySelectorAll('button,[role="button"]')].find((b) => /menu|navigation|nav/i.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('aria-expanded') || ''} ${b.className || ''}`));
    const navLinks = document.querySelectorAll('header a, nav a, [role="navigation"] a').length;
    const sticky = Boolean(headerCs && (headerCs.position === 'fixed' || headerCs.position === 'sticky'));
    const containers = [...document.querySelectorAll('main, [class*="container"], [class*="wrapper"], section > div')].slice(0, 200);
    const containerWidths = new Map();
    for (const c of containers) add(containerWidths, px(getComputedStyle(c).width));
    const pageHeight = Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, body ? body.scrollHeight : 0);
    return {
        url: location.href, title: document.title, lang: document.documentElement.lang || null,
        fonts: { families: top(fonts, 8, total), sizes: top(sizes, 16, total), weights: top(weights, 6, total), line_heights: top(lines, 8, total) },
        palette: { text: top(colours, 10, total), backgrounds: top(backgrounds, 10, total), borders: top(borders, 8, total) },
        spacing: top(pads, 16, total * 2), margins: top(margins, 12, total * 2), gaps: top(gaps, 10, total), radii: top(radii, 10, total), shadows: top(shadows, 8, total),
        grid: { grid_elements: grid, flex_elements: flex, container_widths: top(containerWidths, 8, containers.length), page_height: pageHeight, viewport_width: innerWidth, viewport_height: innerHeight },
        navigation: { header: Boolean(header), position: headerCs ? headerCs.position : null, sticky, links: navLinks, menu_button: Boolean(menuButton), menu_label: menuButton ? clean(menuButton.getAttribute('aria-label') || menuButton.innerText, 80) : null, items: [...document.querySelectorAll('header a, nav a, [role="navigation"] a')].slice(0, 20).map((a) => clean(a.innerText, 60)) },
        outline: headings,
        buttons, links,
        components: { images, svgs, videos, inputs, forms, tables, dialogs, cards, canvases, navs: document.querySelectorAll('nav').length, sections: document.querySelectorAll('section').length },
        words: { h1: clean((document.querySelector('h1') || {}).innerText, 300), title: clean(document.title, 200), description: clean((document.querySelector('meta[name="description"]') || {}).content, 300), buttons: buttons.slice(0, 30).map((b) => b.text).filter(Boolean), links: links.slice(0, 40).map((l) => l.text).filter(Boolean) },
        meta: { viewport: clean((document.querySelector('meta[name="viewport"]') || {}).content, 200), theme_color: clean((document.querySelector('meta[name="theme-color"]') || {}).content, 40), generator: clean((document.querySelector('meta[name="generator"]') || {}).content, 100) },
    };
}

/** The Expert measurements (the metrics script's readings plus the navigation timing). */
function readMetrics() {
    const m = window.__ovMetrics || {};
    const nav = performance.getEntriesByType('navigation')[0];
    const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
    return {
        lcp_ms: m.lcp ? m.lcp.ms : null, lcp_element: m.lcp ? m.lcp.element : null,
        cls: Math.round((m.cls || 0) * 1000) / 1000, inp_ms: m.inp ? m.inp.ms : null,
        long_tasks: m.long_tasks || 0, poor_interactions: m.poor_interactions || 0,
        dom_content_loaded_ms: nav ? round(nav.domContentLoadedEventEnd) : null,
        load_ms: nav ? round(nav.loadEventEnd) : null,
        transfer_bytes: nav ? round(nav.transferSize) : null,
    };
}

module.exports = { METRICS_INIT, collectDom, readMetrics };
