// Invariants for every variant, not just the baseline.
//
// Assertions 1-5 check the generated site is still CORRECT. Assertion 6 checks
// it is actually DIFFERENT. Six is the load-bearing one: without it a variant
// that silently became a no-op would pass everything else, and a heal test run
// against it would be measuring nothing at all.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { CONSTANT_PRICE, VARIANTS, VISIT_HOLD_MS, build, detailHref, esc, pageHref } from "../build.mjs";

/**
 * The four atomic detail breaks. `detail-restructured` is exactly their union,
 * so a heal test can be run four times over — one field per round — instead of
 * being spent on the first. Assertion 6 reads this table, so adding an atom
 * without a marker pair here is a test failure rather than a silent no-op.
 */
const DETAIL_ATOMS = [
  "detail-title-moved",
  "detail-specs-dl",
  "detail-description-wrapped",
  "detail-sku-folded",
];

/** Each case: the variants to build, and what must have changed as a result. */
const CASES = [
  { name: "baseline", variants: [] },
  ...VARIANTS.map((v) => ({ name: v, variants: [v] })),
  { name: "compound", variants: ["renamed-classes", "broken-pagination"] },
  { name: "detail-atoms-union", variants: DETAIL_ATOMS },
];

const built = new Map();
const tmpDirs = [];

before(async () => {
  for (const c of CASES) {
    const outDir = await mkdtemp(join(tmpdir(), `ssh-${c.name}-`));
    tmpDirs.push(outDir);
    const result = await build({ outDir, variants: c.variants });
    const pages = new Map();
    for (const name of result.written) {
      pages.set(name, await readFile(join(outDir, name), "utf8"));
    }
    const items = JSON.parse(await readFile(new URL("../data/items.json", import.meta.url), "utf8"));
    const extra = JSON.parse(await readFile(new URL("../data/clearance.json", import.meta.url), "utf8"));
    built.set(c.name, { ...result, pages, items, extra, outDir });
  }
});

after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function listPageNames(b) {
  return Array.from({ length: b.totalPages }, (_, i) => pageHref(i + 1, b.theme));
}

function countCards(html, theme) {
  const re = new RegExp(`<${theme.card.tag} class="${theme.card.cls}"`, "g");
  return (html.match(re) ?? []).length;
}

function nextHref(html, theme) {
  const re = theme.pager.asButton
    ? /<button class="pager-next" type="button" data-target="([^"]+)"/
    : /<a class="pager-next" rel="next" href="([^"]+)"/;
  return html.match(re)?.[1];
}

for (const c of CASES) {
  describe(`variant: ${c.name}`, () => {
    it("1. every item's values survive the render", (t) => {
      // The two variants that change what the site says check their own claim below.
      if (c.variants.includes("data-removed")) return t.skip("data-removed renders no values");
      const b = built.get(c.name);
      const whole = [...b.pages.values()].join("\n");
      const priceConstant = c.variants.includes("price-constant");

      for (const item of b.items) {
        for (const [field, value] of [
          ["title", esc(item.title)],
          ["sku", esc(item.sku)],
          ["price", priceConstant ? `${CONSTANT_PRICE}` : `${item.price}`],
          ["brand", esc(item.brand)],
          ["category", esc(item.category)],
          ["description", esc(item.description)],
          ["released", esc(item.released)],
        ]) {
          assert.ok(
            whole.includes(value),
            `${item.slug}: ${field} ${JSON.stringify(value)} is missing from the site — ` +
              `a variant must change markup, never data`,
          );
        }
      }
    });

    it("2. cards sum to the catalogue, each item on exactly one list page", () => {
      const b = built.get(c.name);
      const names = listPageNames(b);

      const appended = b.theme.extraPagesLinked !== null ? b.extra : [];
      const listed = [...b.items, ...appended];
      const total = names.reduce((n, name) => n + countCards(b.pages.get(name), b.theme), 0);
      assert.equal(total, listed.length, "card count across list pages");

      for (const item of listed) {
        const hits = names.filter((name) => b.pages.get(name).includes(`href="${detailHref(item)}"`));
        assert.equal(hits.length, 1, `${item.slug} should be linked from exactly 1 list page, got ${hits.length}`);
      }
    });

    it("3. every card link resolves to a page that was written", () => {
      const b = built.get(c.name);
      for (const name of listPageNames(b)) {
        const links = [...b.pages.get(name).matchAll(/href="(item-[^"]+\.html)"/g)].map((m) => m[1]);
        assert.ok(links.length > 0, `${name} has no item links`);
        for (const link of links) {
          assert.ok(b.pages.has(link), `${name} links to ${link}, which was never written`);
        }
      }
    });

    it("4. the pager chain is intact, finite, and covers every list page once", () => {
      const b = built.get(c.name);
      const visited = [];
      let current = "index.html";

      while (current) {
        assert.ok(!visited.includes(current), `pager loops back to ${current}`);
        assert.ok(b.pages.has(current), `pager points at ${current}, which was never written`);
        visited.push(current);
        current = nextHref(b.pages.get(current), b.theme);
      }

      // extra-pages-unlinked: pages 14-16 exist, but the pager stops at 13.
      const reachable =
        b.theme.extraPagesLinked === false ? Math.ceil(b.items.length / 12) : b.totalPages;
      assert.equal(visited.length, reachable, "pages reachable by following the pager");
      assert.deepEqual(visited, listPageNames(b).slice(0, reachable), "pager order");
    });

    it("5. every page is stamped with the variant", () => {
      const b = built.get(c.name);
      const expected = c.variants.length ? c.variants.join(",") : "baseline";
      assert.equal(b.variant, expected);
      for (const [name, html] of b.pages) {
        assert.ok(html.includes(`<!-- variant: ${expected} -->`), `${name} is missing its variant stamp`);
      }
    });

    it("6. the break actually happened", () => {
      const b = built.get(c.name);
      const lists = listPageNames(b).map((n) => b.pages.get(n)).join("\n");
      const details = b.items.map((i) => b.pages.get(detailHref(i))).join("\n");
      const has = (hay, needle) => hay.includes(needle);

      // Baseline markers, asserted present when the variant does NOT touch them
      // and absent when it does. Stated as one table so a variant can never
      // quietly stop breaking what it claims to break.
      const removed = c.variants.includes("data-removed");
      const renamed = c.variants.includes("renamed-classes") || removed;
      const moved = c.variants.includes("moved-fields");
      const pager = c.variants.includes("broken-pagination");
      // A detail atom is in effect either on its own or via the bundle, which is
      // defined to be their union. Asserted per atom so a narrow variant that
      // stopped breaking its one field cannot hide inside the bundle's pass.
      const atom = (name) =>
        c.variants.includes(name) || c.variants.includes("detail-restructured") || removed;

      assert.equal(has(lists, '<article class="product-card"'), !c.variants.includes("renamed-classes"), "product-card container");
      assert.equal(has(lists, 'class="listing-tile"'), c.variants.includes("renamed-classes"), "listing-tile container");
      assert.equal(has(lists, 'class="product-title"'), !renamed, "product-title");

      assert.equal(has(lists, '<span class="price">'), !moved && !renamed, "visible price span");
      assert.equal(has(lists, 'data-price="'), moved, "price as a data attribute");
      assert.equal(has(lists, '<span class="sku">'), !moved && !renamed, "sku span on cards");
      assert.equal(has(lists, "reviews</span>"), !moved && !removed, "standalone review count");

      assert.equal(has(lists, 'rel="next"'), !pager, "href-bearing next link");
      assert.equal(has(lists, "<button class=\"pager-next\""), pager, "next as a button");
      assert.equal(b.pages.has("page-2.html"), !pager, "page-2.html");
      assert.equal(b.pages.has("p2.html"), pager, "p2.html");
      assert.equal(has(lists, 'href="page-2.html"'), !pager, "link to page-2.html");

      const titleMoved = atom("detail-title-moved");
      assert.equal(has(details, 'class="detail-title"'), !titleMoved, "detail-title");
      assert.equal(has(details, 'class="page-heading"'), titleMoved && !removed, "page-heading");
      assert.equal(
        has(details, '<header class="detail-header">'),
        titleMoved && !removed,
        "title lifted out of <main> into a <header>",
      );

      const specsDl = atom("detail-specs-dl");
      assert.equal(has(details, '<table class="specs">'), !specsDl, "spec table");
      assert.equal(has(details, '<dl class="attributes">'), specsDl && !removed, "spec definition list");

      const descWrapped = atom("detail-description-wrapped");
      assert.equal(has(details, 'class="detail-description"'), !descWrapped, "detail-description");
      assert.equal(has(details, 'class="overview-body"'), descWrapped && !removed, "overview wrapper");

      // Spec keys are Weight/Dimensions/Material/Finish/Warranty and sku values
      // read "SKU-1005", so `>SKU<` matches the folded key cell and nothing else.
      const skuFolded = atom("detail-sku-folded");
      assert.equal(has(details, 'class="detail-sku"'), !skuFolded, "standalone detail sku");
      assert.equal(has(details, ">SKU<"), skuFolded && !removed, "sku folded in as a spec row");
    });
  });
}

describe("the detail atoms", () => {
  const stripStamp = (html) => html.replace(/<!-- variant: [^>]*-->/, "");

  it("sum to exactly detail-restructured", () => {
    const bundle = built.get("detail-restructured");
    const union = built.get("detail-atoms-union");

    for (const item of bundle.items) {
      const name = detailHref(item);
      assert.equal(
        stripStamp(union.pages.get(name)),
        stripStamp(bundle.pages.get(name)),
        `${name}: the four atoms together must render what detail-restructured renders, ` +
          `or the runbook's bundled break has drifted from its parts`,
      );
    }
  });

  for (const name of DETAIL_ATOMS) {
    it(`${name} leaves the list pages completely untouched`, () => {
      const base = built.get("baseline");
      const b = built.get(name);

      for (const page of listPageNames(base)) {
        assert.equal(
          stripStamp(b.pages.get(page)),
          stripStamp(base.pages.get(page)),
          `${page} changed — a detail atom must break only the detail step`,
        );
      }
    });
  }
});

describe("the open-tab test page", () => {
  it("opens visit.html in a new tab and waits the hold time before counting", () => {
    const b = built.get("baseline");
    const html = b.pages.get("open-tab.html");
    assert.ok(html, "open-tab.html was never written");
    assert.ok(b.pages.has("visit.html"), "visit.html was never written");
    assert.match(html, /data-target="visit\.html"/);
    assert.match(html, /window\.open\(button\.dataset\.target, "_blank"\)/);
    assert.match(html, new RegExp(`const HOLD_MS = ${VISIT_HOLD_MS};`));
    assert.match(html, /<span id="visit-count" class="visit-count">0<\/span>/);
  });

  it("is reached from no catalogue page, so saved workflows never see it", () => {
    for (const c of CASES) {
      for (const [name, html] of built.get(c.name).pages) {
        if (name === "open-tab.html" || name === "visit.html") continue;
        assert.ok(!html.includes("open-tab.html") && !html.includes("visit.html"), `${c.name}/${name} links to the tab test`);
      }
    }
  });

  it("renders the same in every variant", () => {
    const stripStamp = (html) => html.replace(/<!-- variant: [^>]*-->/, "");
    const base = built.get("baseline");
    for (const c of CASES) {
      for (const name of ["open-tab.html", "visit.html"]) {
        assert.equal(stripStamp(built.get(c.name).pages.get(name)), stripStamp(base.pages.get(name)), `${c.name}/${name}`);
      }
    }
  });
});

describe("output hygiene", () => {
  it("clears stale pages, so a renamed pager cannot keep working", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ssh-stale-"));
    tmpDirs.push(outDir);

    await build({ outDir, variants: [] });
    const before = await readdir(outDir);
    assert.ok(before.includes("page-2.html"));

    await build({ outDir, variants: ["broken-pagination"] });
    const after = await readdir(outDir);

    assert.ok(!after.includes("page-2.html"), "page-2.html survived a broken-pagination rebuild");
    assert.ok(after.includes("p2.html"));
    assert.ok(after.includes(".nojekyll"), ".nojekyll must exist after every build");
  });

  it("rejects an unknown variant instead of silently building the baseline", async () => {
    await assert.rejects(() => build({ outDir: tmpDirs[0], variants: ["renamed-clases"] }), /unknown variant/);
  });
});

describe("the content variants", () => {
  it("data-removed shows no product value anywhere, at the baseline's URLs", () => {
    const base = built.get("baseline");
    const b = built.get("data-removed");
    assert.deepEqual([...b.pages.keys()].sort(), [...base.pages.keys()].sort(), "same URLs");
    const whole = [...b.pages.values()].join("\n");
    for (const item of b.items) {
      for (const value of [esc(item.title), esc(item.sku), `$${item.price}`, esc(item.description)]) {
        assert.ok(!whole.includes(value), `${item.slug}: ${value} is still on the site`);
      }
    }
  });

  it("price-constant shows one price on every card and detail page", () => {
    const b = built.get("price-constant");
    const shown = [...b.pages.values()]
      .join("\n")
      .matchAll(/<span class="price">\$([0-9.]+)<\/span>/g);
    const prices = new Set([...shown].map((m) => m[1]));
    assert.deepEqual([...prices], [CONSTANT_PRICE]);
  });

  it("hidden-category lists 30 more products only behind the nav's Clearance link", () => {
    const base = built.get("baseline");
    const b = built.get("hidden-category");
    const clearance = ["clearance.html", "clearance-2.html", "clearance-3.html"];
    const cards = clearance.reduce((n, name) => n + countCards(b.pages.get(name), b.theme), 0);
    assert.equal(cards, b.extra.length);
    for (const item of b.extra) assert.ok(b.pages.has(detailHref(item)), `${item.slug} detail page`);
    assert.ok(b.pages.get("index.html").includes('<a href="clearance.html">Clearance</a>'));
    assert.ok(b.pages.get("index.html").includes(`${b.items.length + b.extra.length} products`));
    for (const name of listPageNames(base)) {
      assert.ok(!b.pages.get(name).includes("item-clearance-"), `${name} lists a clearance item`);
    }
  });

  it("extra-pages appends pages 14-16; extra-pages-unlinked leaves page 13 without a Next", () => {
    const linked = built.get("extra-pages");
    const unlinked = built.get("extra-pages-unlinked");
    assert.equal(nextHref(linked.pages.get("page-13.html"), linked.theme), "page-14.html");
    assert.equal(nextHref(unlinked.pages.get("page-13.html"), unlinked.theme), undefined);
    assert.ok(unlinked.pages.has("page-14.html") && unlinked.pages.has("page-16.html"));
    const base = built.get("baseline");
    const strip = (html) => html.replace(/<!-- variant: [^>]*-->/, "").replace(/\d+ products/, "");
    assert.equal(
      strip(linked.pages.get("page-12.html")).replace(/of 16/, "of 13"),
      strip(base.pages.get("page-12.html")),
      "pages 1-12 keep their baseline items",
    );
  });
});
