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

import { VARIANTS, build, detailHref, esc, pageHref } from "../build.mjs";

/** Each case: the variants to build, and what must have changed as a result. */
const CASES = [
  { name: "baseline", variants: [] },
  ...VARIANTS.map((v) => ({ name: v, variants: [v] })),
  { name: "compound", variants: ["renamed-classes", "broken-pagination"] },
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
    built.set(c.name, { ...result, pages, items, outDir });
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
    it("1. every item's values survive the render", () => {
      const b = built.get(c.name);
      const whole = [...b.pages.values()].join("\n");

      for (const item of b.items) {
        for (const [field, value] of [
          ["title", esc(item.title)],
          ["sku", esc(item.sku)],
          ["price", `$${item.price}`],
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

      const total = names.reduce((n, name) => n + countCards(b.pages.get(name), b.theme), 0);
      assert.equal(total, b.items.length, "card count across list pages");

      for (const item of b.items) {
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

      assert.equal(visited.length, b.totalPages, "pages reachable by following the pager");
      assert.deepEqual(visited, listPageNames(b), "pager order");
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
      const renamed = c.variants.includes("renamed-classes");
      const moved = c.variants.includes("moved-fields");
      const pager = c.variants.includes("broken-pagination");
      const detail = c.variants.includes("detail-restructured");

      assert.equal(has(lists, '<article class="product-card"'), !renamed, "product-card container");
      assert.equal(has(lists, 'class="listing-tile"'), renamed, "listing-tile container");
      assert.equal(has(lists, 'class="product-title"'), !renamed, "product-title");

      assert.equal(has(lists, '<span class="price">'), !moved && !renamed, "visible price span");
      assert.equal(has(lists, 'data-price="'), moved, "price as a data attribute");
      assert.equal(has(lists, '<span class="sku">'), !moved && !renamed, "sku span on cards");
      assert.equal(has(lists, "reviews</span>"), !moved, "standalone review count");

      assert.equal(has(lists, 'rel="next"'), !pager, "href-bearing next link");
      assert.equal(has(lists, "<button class=\"pager-next\""), pager, "next as a button");
      assert.equal(b.pages.has("page-2.html"), !pager, "page-2.html");
      assert.equal(b.pages.has("p2.html"), pager, "p2.html");
      assert.equal(has(lists, 'href="page-2.html"'), !pager, "link to page-2.html");

      assert.equal(has(details, '<table class="specs">'), !detail, "spec table");
      assert.equal(has(details, '<dl class="attributes">'), detail, "spec definition list");
      assert.equal(has(details, 'class="detail-title"'), !detail, "detail-title");
      assert.equal(has(details, 'class="page-heading"'), detail, "page-heading");
    });
  });
}

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
