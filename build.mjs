#!/usr/bin/env node
// Markup plane. Renders docs/ from data/items.json + site.config.json.
//
// This script NEVER invents or alters a value — it only re-renders what is in
// the data file. Variants change markup and nothing else, so a record-count or
// field-coverage change observed by the self-healer is attributable to the
// structural break rather than to shifting content.
//
//   node build.mjs                                    # baseline
//   node build.mjs --variant=renamed-classes
//   node build.mjs --variant=renamed-classes,broken-pagination
//   node build.mjs --out=/tmp/site --variant=moved-fields

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The detail page's break, split into one variant per field.
 *
 * A heal test is spent once the healer fixes it: re-applying the same break to
 * an already-healed workflow no longer breaks anything, because the healed spec
 * targets the new markup. So the detail break is offered a field at a time —
 * four narrow variants, four rounds, a fresh field each round — and
 * `detail-restructured` remains exactly their union for the bundled case.
 */
export const DETAIL_ATOMS = [
  "detail-title-moved",
  "detail-specs-dl",
  "detail-description-wrapped",
  "detail-sku-folded",
];

export const VARIANTS = [
  "renamed-classes",
  "moved-fields",
  "broken-pagination",
  "detail-restructured",
  ...DETAIL_ATOMS,
];

export function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The single description of what the markup looks like. Baseline first, then
 * each variant mutates it. Every render function reads from here, so a variant
 * is a handful of field assignments rather than a forked template.
 */
export function buildTheme(variants = []) {
  const unknown = variants.filter((v) => !VARIANTS.includes(v));
  if (unknown.length) {
    throw new Error(
      `unknown variant(s): ${unknown.join(", ")}. known: ${VARIANTS.join(", ")}`,
    );
  }

  const t = {
    variants,
    stamp: variants.length ? variants.join(",") : "baseline",
    card: { tag: "article", cls: "product-card", skuAttr: true, priceAttrs: false },
    cls: {
      title: "product-title",
      brand: "product-brand",
      category: "product-category",
      price: "price",
      priceWas: "price-was",
      sku: "sku",
      stock: "stock",
      rating: "rating",
      review: "review-count",
    },
    showPriceSpans: true,
    showSkuSpan: true,
    mergeReviewsIntoRating: false,
    pager: { asButton: false, pattern: "page-%d.html" },
    detail: {
      titleCls: "detail-title",
      titleInHeader: false,
      specsAsDl: false,
      skuInSpecs: false,
      overviewWrapper: false,
    },
  };

  for (const variant of variants) {
    if (variant === "renamed-classes") {
      // A redesign: the container changes tag AND class, and every field class
      // is renamed. Pager and detail pages are untouched, so the break is
      // purely "the list selectors died" — the canonical zero-record case.
      t.card.tag = "div";
      t.card.cls = "listing-tile";
      t.cls.title = "tile-heading";
      t.cls.brand = "tile-maker";
      t.cls.category = "tile-cat";
      t.cls.price = "amount";
      t.cls.priceWas = "amount-was";
      t.cls.sku = "item-code";
      t.cls.stock = "availability";
      t.cls.rating = "score";
      t.cls.review = "score-count";
    }

    if (variant === "moved-fields") {
      // The container survives; individual fields move or reshape. Items are
      // still found, so this exercises field coverage rather than record count.
      t.showPriceSpans = false; // price lives on the card as a data attribute
      t.card.priceAttrs = true;
      t.showSkuSpan = false; // SKU is detail-only now
      t.card.skuAttr = false;
      t.mergeReviewsIntoRating = true; // .review-count disappears into .rating
    }

    if (variant === "broken-pagination") {
      // Cards and detail pages keep working. The pager stops being a link and
      // the page files are renamed, so BOTH reading the site's own next href
      // and constructing page-N+1 fail.
      t.pager.asButton = true;
      t.pager.pattern = "p%d.html";
    }

  }

  // List pages untouched; only the detail step breaks. Applied as a set rather
  // than in the loop above, because `detail-restructured` is defined to be the
  // union of the atoms and each atom flips one independent flag.
  const detailBreaks = new Set(
    variants.includes("detail-restructured")
      ? DETAIL_ATOMS
      : variants.filter((v) => DETAIL_ATOMS.includes(v)),
  );

  if (detailBreaks.has("detail-title-moved")) {
    // The one field almost every spec extracts: renamed AND lifted out of
    // <main>, so neither the class nor a descendant path survives.
    t.detail.titleCls = "page-heading";
    t.detail.titleInHeader = true;
  }
  if (detailBreaks.has("detail-specs-dl")) t.detail.specsAsDl = true;
  if (detailBreaks.has("detail-description-wrapped")) t.detail.overviewWrapper = true;
  if (detailBreaks.has("detail-sku-folded")) t.detail.skuInSpecs = true;

  return t;
}

export function pageHref(n, t) {
  return n === 1 ? "index.html" : t.pager.pattern.replace("%d", String(n));
}

export function detailHref(item) {
  return `item-${item.slug}.html`;
}

function layout({ title, stamp, body, cfg }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(cfg.siteName)}</title>
<link rel="stylesheet" href="assets/site.css">
</head>
<!-- variant: ${stamp} -->
<body>
<header class="site-header">
  <a class="site-logo" href="index.html">${esc(cfg.siteName)}</a>
  <nav class="site-nav">
    <a href="index.html">Catalogue</a>
    <a href="about.html">About</a>
    <a href="contact.html">Contact</a>
  </nav>
</header>
${body}
<footer class="site-footer">
  <p>${esc(cfg.siteName)} — furniture and fittings for working rooms.</p>
  <p class="footer-fine">Prices shown in USD. This is a test fixture, not a real shop.</p>
</footer>
</body>
</html>
`;
}

function renderCard(item, t) {
  const attrs = [];
  if (t.card.skuAttr) attrs.push(`data-sku="${esc(item.sku)}"`);
  if (t.card.priceAttrs) {
    attrs.push(`data-price="${esc(item.price)}"`);
    attrs.push(`data-currency="${esc(item.currency)}"`);
    if (item.priceWas) attrs.push(`data-price-was="${esc(item.priceWas)}"`);
  }
  const attr = attrs.length ? ` ${attrs.join(" ")}` : "";
  const href = detailHref(item);

  const pricing = t.showPriceSpans
    ? `        <div class="product-pricing">
          <span class="${t.cls.price}">$${esc(item.price)}</span>${
            item.priceWas
              ? `\n          <span class="${t.cls.priceWas}">$${esc(item.priceWas)}</span>`
              : ""
          }
        </div>\n`
    : "";

  const rating = t.mergeReviewsIntoRating
    ? `          <span class="${t.cls.rating}" data-rating="${esc(item.rating)}">${esc(item.rating)} (${item.reviewCount} reviews)</span>\n`
    : `          <span class="${t.cls.rating}" data-rating="${esc(item.rating)}">${esc(item.rating)}</span>
          <span class="${t.cls.review}">${item.reviewCount} reviews</span>\n`;

  const sku = t.showSkuSpan
    ? `          <span class="${t.cls.sku}">${esc(item.sku)}</span>\n`
    : "";

  const stockState = item.inStock ? "in-stock" : "out-of-stock";

  return `    <${t.card.tag} class="${t.card.cls}"${attr}>
      <a class="product-link" href="${href}">
        <img class="product-thumb" src="img/placeholder.svg" alt="${esc(item.title)}" width="400" height="300">
      </a>
      <div class="product-body">
        <span class="${t.cls.category}">${esc(item.category)}</span>
        <h3 class="${t.cls.title}"><a href="${href}">${esc(item.title)}</a></h3>
        <p class="${t.cls.brand}">${esc(item.brand)}</p>
${pricing}        <div class="product-meta">
${rating}${sku}          <span class="${t.cls.stock} ${stockState}">${esc(item.stockLabel)}</span>
        </div>
      </div>
    </${t.card.tag}>`;
}

function renderPager(pageNo, totalPages, t) {
  const parts = [`  <span class="pager-current">Page ${pageNo} of ${totalPages}</span>`];

  if (pageNo > 1) {
    parts.unshift(
      `  <a class="pager-prev" rel="prev" href="${pageHref(pageNo - 1, t)}">Previous</a>`,
    );
  }

  if (pageNo < totalPages) {
    const next = pageHref(pageNo + 1, t);
    parts.push(
      t.pager.asButton
        ? `  <button class="pager-next" type="button" data-target="${next}">Next &rsaquo;</button>`
        : `  <a class="pager-next" rel="next" href="${next}">Next</a>`,
    );
  }

  return `<nav class="pagination" aria-label="Pagination">
${parts.join("\n")}
</nav>`;
}

function renderSidebar(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  // Deliberately NOT links: a facet link on a static host would serve page 1
  // again, inviting a fan-out that yields duplicates for a reason this fixture
  // is not meant to test.
  const rows = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([name, n]) =>
        `    <li class="filter-row"><span class="filter-name">${esc(name)}</span> <span class="filter-count">${n}</span></li>`,
    )
    .join("\n");

  return `<aside class="sidebar">
  <h2 class="sidebar-title">Browse by room</h2>
  <ul class="filter-list">
${rows}
  </ul>
  <p class="sidebar-note">Filtering is handled at the counter. Call us.</p>
</aside>`;
}

function renderListPage({ pageItems, pageNo, totalPages, allItems, t, cfg }) {
  const body = `<div class="promo-banner">Free delivery on orders over $75 · collection from the workshop any weekday</div>
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="index.html">Home</a> <span class="crumb-sep">/</span> <span class="crumb-current">Catalogue</span>
</nav>
<div class="layout">
${renderSidebar(allItems)}
  <main class="listing">
    <h1 class="listing-title">${esc(cfg.listingTitle)}</h1>
    <p class="result-count">${allItems.length} products</p>
    <div class="product-grid">
${pageItems.map((item) => renderCard(item, t)).join("\n")}
    </div>
${renderPager(pageNo, totalPages, t)}
    <section class="listing-copy">
      <h2>About this catalogue</h2>
      <p>Every piece here is stocked in the workshop and shipped from it. We list weight,
      dimensions and material on each product page because those are the numbers that
      decide whether a thing fits your room, and we would rather you knew before ordering.</p>
      <p>Ratings come from customers who bought the item. We do not solicit them and we do
      not remove the unflattering ones.</p>
    </section>
  </main>
</div>`;

  return layout({
    title: pageNo === 1 ? cfg.listingTitle : `${cfg.listingTitle} — page ${pageNo}`,
    stamp: t.stamp,
    body,
    cfg,
  });
}

function renderSpecs(item, t) {
  const rows = Object.entries(item.specs);
  if (t.detail.skuInSpecs) rows.unshift(["SKU", item.sku]);

  if (t.detail.specsAsDl) {
    return `  <dl class="attributes">
${rows.map(([k, v]) => `    <dt>${esc(k)}</dt>\n    <dd>${esc(v)}</dd>`).join("\n")}
  </dl>`;
  }

  return `  <table class="specs">
    <tbody>
${rows
  .map(
    ([k, v]) =>
      `      <tr><th class="spec-name">${esc(k)}</th><td class="spec-value">${esc(v)}</td></tr>`,
  )
  .join("\n")}
    </tbody>
  </table>`;
}

function renderDetailPage({ item, t, cfg }) {
  const heading = `<h1 class="${t.detail.titleCls}">${esc(item.title)}</h1>`;

  const description = t.detail.overviewWrapper
    ? `  <section class="overview">
    <h2 class="overview-title">Overview</h2>
    <div class="overview-body"><p>${esc(item.description)}</p></div>
  </section>`
    : `  <div class="detail-description"><p>${esc(item.description)}</p></div>`;

  const price = `  <div class="detail-price"><span class="price">$${esc(item.price)}</span>${
    item.priceWas ? `<span class="price-was">$${esc(item.priceWas)}</span>` : ""
  }</div>`;

  const sku = t.detail.skuInSpecs
    ? ""
    : `  <p class="detail-sku">${esc(item.sku)}</p>\n`;

  const body = `<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="index.html">Home</a> <span class="crumb-sep">/</span>
  <span class="crumb-category">${esc(item.category)}</span> <span class="crumb-sep">/</span>
  <span class="crumb-current">${esc(item.title)}</span>
</nav>
${t.detail.titleInHeader ? `<header class="detail-header">\n  ${heading}\n</header>\n` : ""}<main class="product-detail">
${t.detail.titleInHeader ? "" : `  ${heading}\n`}  <p class="detail-brand">${esc(item.brand)}</p>
${price}
${sku}  <p class="detail-stock ${item.inStock ? "in-stock" : "out-of-stock"}">${esc(item.stockLabel)}</p>
${description}
${renderSpecs(item, t)}
  <p class="detail-released">Released ${esc(item.released)}</p>
  <p class="detail-back"><a href="index.html">Back to the catalogue</a></p>
</main>`;

  return layout({ title: item.title, stamp: t.stamp, body, cfg });
}

function renderStaticPage({ heading, paragraphs, t, cfg }) {
  const body = `<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="index.html">Home</a> <span class="crumb-sep">/</span> <span class="crumb-current">${esc(heading)}</span>
</nav>
<main class="static-page">
  <h1>${esc(heading)}</h1>
${paragraphs.map((p) => `  <p>${esc(p)}</p>`).join("\n")}
</main>`;
  return layout({ title: heading, stamp: t.stamp, body, cfg });
}

const CSS = `:root{--ink:#1b1b1a;--muted:#6b6b66;--line:#e2ded6;--bg:#faf8f4;--accent:#7a4a2b}
*{box-sizing:border-box}
body{margin:0;font:16px/1.55 "Iowan Old Style",Georgia,serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}
.site-header{display:flex;align-items:baseline;gap:2rem;padding:1.1rem 2rem;border-bottom:1px solid var(--line);background:#fff}
.site-logo{font-size:1.3rem;font-weight:700;text-decoration:none;letter-spacing:-.01em}
.site-nav{display:flex;gap:1.25rem;font-size:.9rem}
.promo-banner{padding:.6rem 2rem;background:#2f2b26;color:#f6efe4;font-size:.85rem;text-align:center}
.breadcrumb{padding:.9rem 2rem;font-size:.82rem;color:var(--muted)}
.crumb-sep{opacity:.5;margin:0 .2rem}
.layout{display:flex;gap:2.5rem;padding:0 2rem 3rem;align-items:flex-start}
.sidebar{flex:0 0 210px;padding:1.2rem;border:1px solid var(--line);background:#fff}
.sidebar-title{margin:0 0 .7rem;font-size:.95rem;text-transform:uppercase;letter-spacing:.06em}
.filter-list{list-style:none;margin:0;padding:0;font-size:.9rem}
.filter-row{display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px dotted var(--line)}
.filter-count{color:var(--muted)}
.sidebar-note{font-size:.78rem;color:var(--muted);margin:.9rem 0 0}
.listing{flex:1;min-width:0}
.listing-title{margin:0;font-size:2rem;letter-spacing:-.02em}
.result-count{margin:.2rem 0 1.4rem;color:var(--muted);font-size:.9rem}
.product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1.5rem}
.product-card,.listing-tile{background:#fff;border:1px solid var(--line);display:flex;flex-direction:column}
.product-thumb{width:100%;height:auto;display:block;background:#efeae1}
.product-body{padding:.9rem 1rem 1.1rem;display:flex;flex-direction:column;gap:.3rem}
.product-category,.tile-cat{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.product-title,.tile-heading{margin:0;font-size:1.02rem;line-height:1.3}
.product-title a,.tile-heading a{text-decoration:none;color:var(--ink)}
.product-brand,.tile-maker{margin:0;font-size:.82rem;color:var(--muted)}
.product-pricing{margin-top:.35rem}
.price,.amount{font-size:1.15rem;font-weight:700}
.price-was,.amount-was{margin-left:.45rem;color:var(--muted);text-decoration:line-through;font-size:.9rem}
.product-meta{margin-top:.5rem;display:flex;flex-wrap:wrap;gap:.55rem;font-size:.78rem;color:var(--muted)}
.stock.in-stock,.availability.in-stock,.detail-stock.in-stock{color:#2f6b3a}
.stock.out-of-stock,.availability.out-of-stock,.detail-stock.out-of-stock{color:#9a3324}
.pagination{margin:2.2rem 0;display:flex;align-items:center;gap:1rem;font-size:.9rem}
.pager-next,.pager-prev{text-decoration:none}
button.pager-next{font:inherit;font-size:.9rem;padding:.35rem .8rem;border:1px solid var(--line);background:#fff;cursor:pointer;color:var(--accent)}
.pager-current{color:var(--muted)}
.listing-copy{margin-top:2.5rem;padding-top:1.5rem;border-top:1px solid var(--line);max-width:62ch;font-size:.9rem;color:#3c3a36}
.listing-copy h2{font-size:1rem;text-transform:uppercase;letter-spacing:.06em}
.product-detail,.static-page,.detail-header{padding:0 2rem 3rem;max-width:70ch}
.detail-header{padding-bottom:0}
.detail-title,.page-heading{margin:0 0 .3rem;font-size:2.1rem;letter-spacing:-.02em}
.detail-brand{margin:0;color:var(--muted)}
.detail-price{margin:1rem 0 .3rem}
.detail-sku{margin:.2rem 0;font-size:.85rem;color:var(--muted)}
.detail-description,.overview{margin:1.4rem 0}
.overview-title{font-size:1rem;text-transform:uppercase;letter-spacing:.06em}
.specs,.attributes{width:100%;border-collapse:collapse;font-size:.9rem;margin:1.4rem 0}
.specs th,.specs td{border-bottom:1px solid var(--line);padding:.5rem .2rem;text-align:left}
.specs th{width:40%;font-weight:600}
.attributes{display:grid;grid-template-columns:40% 60%;gap:0}
.attributes dt{font-weight:600;padding:.5rem .2rem;border-bottom:1px solid var(--line)}
.attributes dd{margin:0;padding:.5rem .2rem;border-bottom:1px solid var(--line)}
.detail-released{font-size:.85rem;color:var(--muted)}
.site-footer{padding:1.6rem 2rem;border-top:1px solid var(--line);background:#fff;font-size:.85rem;color:var(--muted)}
.footer-fine{font-size:.78rem}
`;

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300" role="img" aria-label="Product photograph placeholder">
  <rect width="400" height="300" fill="#efeae1"/>
  <path d="M0 232l104-84 76 60 68-52 152 108z" fill="#ded6c8"/>
  <circle cx="304" cy="80" r="30" fill="#d3c9b8"/>
</svg>
`;

export async function build({
  dataPath = resolve(HERE, "data/items.json"),
  configPath = resolve(HERE, "site.config.json"),
  outDir = resolve(HERE, "docs"),
  variants = [],
} = {}) {
  const t = buildTheme(variants);
  const items = JSON.parse(await readFile(dataPath, "utf8"));
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  const perPage = cfg.itemsPerPage;

  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new Error(`site.config.json itemsPerPage must be a positive integer, got ${perPage}`);
  }
  if (!items.length) throw new Error(`${dataPath} holds no items — run gen-data.mjs first`);

  const totalPages = Math.ceil(items.length / perPage);

  // Clear the output first. A stale page-N.html left behind would keep a
  // constructed pager working under broken-pagination, and the break would not
  // actually break.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "img"), { recursive: true });
  await mkdir(join(outDir, "assets"), { recursive: true });

  const written = [];
  const write = async (name, html) => {
    await writeFile(join(outDir, name), html, "utf8");
    written.push(name);
  };

  await writeFile(join(outDir, ".nojekyll"), "", "utf8");
  await writeFile(join(outDir, "assets/site.css"), CSS, "utf8");
  await writeFile(join(outDir, "img/placeholder.svg"), PLACEHOLDER_SVG, "utf8");

  for (let pageNo = 1; pageNo <= totalPages; pageNo += 1) {
    const pageItems = items.slice((pageNo - 1) * perPage, pageNo * perPage);
    await write(
      pageHref(pageNo, t),
      renderListPage({ pageItems, pageNo, totalPages, allItems: items, t, cfg }),
    );
  }

  for (const item of items) {
    await write(detailHref(item), renderDetailPage({ item, t, cfg }));
  }

  await write(
    "about.html",
    renderStaticPage({
      heading: "About",
      paragraphs: [
        "Fernwood Supply is a fictional workshop invented to give a scraping agent something stable to read.",
        "Nothing on this site is for sale. The catalogue exists so that its structure can be changed on purpose.",
      ],
      t,
      cfg,
    }),
  );

  await write(
    "contact.html",
    renderStaticPage({
      heading: "Contact",
      paragraphs: [
        "There is no counter and no telephone. This page exists so the navigation has somewhere to point.",
      ],
      t,
      cfg,
    }),
  );

  return { variant: t.stamp, items: items.length, totalPages, outDir, written, theme: t };
}

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = arg("variant", "");
  const variants = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const outDir = resolve(HERE, arg("out", "docs"));

  try {
    const r = await build({ variants, outDir });
    console.log(
      `variant ${r.variant} — ${r.items} items, ${r.totalPages} list pages, ${r.written.length} html files → ${r.outDir}`,
    );
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}
