# scrape-self-heal

A static listing site whose **structure can be changed on purpose**, so a scraping
agent's self-healing can be tested end to end instead of waiting for a real site to
redesign itself.

Live at **https://luzivaltic.github.io/scrape-self-heal/**

The catalogue is fictional (150 products, 13 pages, a detail page each). What matters is
that the **URLs stay the same while the markup changes** — that is the only way to make a
saved workflow break the way a real site breaks it.

## Quick start

```sh
node build.mjs        # render docs/ at the baseline
node --test           # check the output is correct AND that variants really differ
```

No dependencies, no install step. Node 18+.

## The loop

```sh
node build.mjs                                   # baseline
node --test && git add -A && git commit -m "baseline" && git push

# → point the builder agent at the site, let it save a workflow, run it.
#   Expect 150 records and full field coverage.

node build.mjs --variant=renamed-classes         # break it
node --test && git add -A && git commit -m "break: renamed classes" && git push

# → re-run the SAME workflow. Expect 0 records, and a heal check to fire.

node build.mjs                                   # back to baseline when you are done
```

Wait for the push to go live and **confirm what is actually being served** before
trusting a run:

```sh
curl -s https://luzivaltic.github.io/scrape-self-heal/ | grep 'variant:'
# <!-- variant: renamed-classes -->
```

Every page carries that stamp. Reading a stale CDN copy is the one way this fixture can
hand you a false heal verdict.

## Variants

`--variant` takes a comma-separated list, so compound breaks work too:
`--variant=renamed-classes,broken-pagination`.

| variant | what changes | expected run outcome |
| --- | --- | --- |
| *(none)* | baseline | 150 records, fields populated |
| `renamed-classes` | Card container becomes `<div class="listing-tile">` and every field class is renamed (`price`→`amount`, `sku`→`item-code`, …). Pager and detail pages untouched. | **run completes with 0 records** — the canonical break: nothing errors, there is just no data |
| `moved-fields` | Container survives. Price becomes a `data-price` attribute, SKU disappears from cards (detail-only), the review count is folded into the rating text. | items still found, but **price, SKU and review count are null on every row** |
| `broken-pagination` | The next link becomes `<button data-target="p2.html">` and page files are renamed `page-N.html` → `pN.html`. Cards untouched. | **12 of 150 records** — there is no next `href` to follow, and a guessed `page-2.html` now 404s |
| `detail-restructured` | List pages untouched. Detail title moves into a `<header>` and is renamed, the spec table becomes a `<dl>`, the description gets a new wrapper. | list fields fine, **detail fields null** |
| `detail-title-moved` | Detail title only: `.detail-title` → `.page-heading`, lifted out of `<main>` into `<header class="detail-header">`. | **detail title null**, every other field fine |
| `detail-specs-dl` | Spec table only: `<table class="specs">` with `.spec-name`/`.spec-value` → `<dl class="attributes">` with `<dt>`/`<dd>`. | **spec fields null**, every other field fine |
| `detail-description-wrapped` | Description only: `.detail-description` → `<section class="overview">` → `.overview-body`. | **detail description null**, every other field fine |
| `detail-sku-folded` | SKU only: the `.detail-sku` paragraph disappears and SKU becomes the first spec row. | **detail SKU null**, every other field fine |

Each variant is deliberately narrow so a heal outcome points at one cause. Together they
cover the four ways a run can be wrong while still reporting success: total failure,
missing fields, missing coverage, and one broken step.

### Running the detail test more than once

`detail-restructured` is exactly the union of the four `detail-*` atoms, and that is what
makes the detail test repeatable. A heal test is **spent** once the healer fixes it:
re-applying the same break to an already-healed workflow breaks nothing, because the
healed spec now targets the new markup. So break one detail field per round instead:

```sh
node build.mjs --variant=detail-title-moved            # round 1 → heal → activate
node build.mjs --variant=detail-specs-dl               # round 2 → heal → activate
node build.mjs --variant=detail-description-wrapped    # round 3
node build.mjs --variant=detail-sku-folded             # round 4
```

Each round is a fresh, never-healed break at unchanged URLs, and the list step stays
green throughout — asserted, not assumed (`node --test` checks every atom's list pages
are byte-identical to the baseline's).

One caveat worth knowing before you read a round as a dud: **a single-field break may sit
below the healer's detection threshold on purpose.** The shape autotest gates on a
regression *ratio*, so if the detail step extracts six fields and one goes blank, the
run can be judged healthy and no heal case opens. That is a real measurement, not a
fixture bug — combine atoms to cross the threshold when you want a heal to fire:

```sh
node build.mjs --variant=detail-title-moved,detail-specs-dl,detail-sku-folded
```

## How it is built

Two scripts, deliberately separate:

**`gen-data.mjs`** — the data plane. `node gen-data.mjs --count=150 --seed=1` writes
`data/items.json`. Seeded, so the same `(count, seed)` always produces byte-identical
output. Run it rarely; commit the result.

**`build.mjs`** — the markup plane. Reads `data/items.json` + `site.config.json` and
renders `docs/`. It **never invents or alters a value.**

That split is the point. A healer decides a workflow is broken partly by comparing field
coverage and record counts against a pinned baseline. If item values drifted between
builds, a heal check would see changes that are not structural breaks, and you could not
tell a real healer failure from fixture churn. Freezing the data makes markup the only
variable.

`build.mjs` clears `docs/` before writing. Without that, a leftover `page-2.html` would
keep a guessed pager working under `broken-pagination`, and the break would not break.

## Changing the catalogue size

```sh
node gen-data.mjs --count=400 --seed=7   # then rebuild and commit
```

Page size lives in `site.config.json` (`itemsPerPage`). **Settle both before the first
agent build.** Changing them is a *content* change, not a structure break: growing
`count` just appends pages and is harmless, but changing `itemsPerPage` reshuffles which
item sits on which page, and shrinking `count` deletes page URLs. Either one breaks a
workflow for a reason the healer is not meant to fix, which muddies the test. Flip
variants for heal tests; change counts only when starting a fresh baseline.

## Tests

`node --test` runs six invariants against **every** variant:

1. every item's values survive the render
2. cards sum to the catalogue, each item on exactly one list page
3. every card link resolves to a page that was written
4. the pager chain is intact, finite, and covers every list page once
5. every page is stamped with its variant
6. **the break actually happened** — the baseline markers are gone

The first five check the site is still *correct*. The sixth checks it is *different* —
without it, a variant that silently became a no-op would pass everything else and a heal
test run against it would be measuring nothing.

Two more groups guard the detail atoms specifically: that the four together render
byte-identical detail pages to `detail-restructured` (so the bundle can never drift from
its parts), and that each atom on its own leaves every list page byte-identical to the
baseline (so a "detail-only" break really is detail-only).

## Deployment

GitHub Pages, **deploy from a branch**: `main` / `/docs`. Set once under
Settings → Pages. `docs/` is generated but committed, so there is no CI step and no
workflow file to keep working. `.nojekyll` stops Jekyll touching the output.

## Notes

- Paths are flat (`index.html`, `page-2.html`, `item-<slug>.html`) so every internal link
  resolves the same on a project Pages URL as it does under any local static server.
- Pagination is path-based rather than `?page=N`, because a static host ignores query
  strings and would serve page 1 forever.
- The sidebar categories are deliberately **not** links. On a static host a facet link
  would serve page 1 again, inviting a fan-out that collects duplicates — a failure that
  has nothing to do with what this fixture tests.
