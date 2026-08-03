#!/usr/bin/env node
// Data plane. Writes data/items.json from a seeded PRNG, so the same
// (count, seed) always produces byte-identical output and re-running is safe.
//
// Values are FROZEN once committed: build.mjs only re-renders markup around
// them. That is what makes a field-coverage change in a heal check attributable
// to the structural break rather than to fixture churn.
//
//   node gen-data.mjs --count=150 --seed=1

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** mulberry32 — small, fast, fully determined by its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIXES = [
  "Aurora", "Meridian", "Cobalt", "Tundra", "Larkspur", "Halden", "Brindle",
  "Selkirk", "Marlow", "Ashgrove", "Verity", "Kestrel", "Dunmore", "Foxglove",
  "Alder", "Thistle", "Rowan", "Cairn", "Bramble", "Weldon", "Pallas",
  "Corvid", "Linden", "Quarry",
];

// `band` is the price range in whole dollars. Without it a mixing bowl set can
// come out at $881.99, which reads as synthetic the moment anyone looks.
const CATEGORIES = [
  { name: "Lighting", band: [39, 329], types: ["Desk Lamp", "Floor Lamp", "Pendant Light", "Wall Sconce", "Reading Light", "Task Lamp"] },
  { name: "Desks", band: [179, 899], types: ["Standing Desk", "Writing Desk", "Corner Desk", "Desk Riser", "Drafting Table", "Console Desk"] },
  { name: "Seating", band: [69, 649], types: ["Task Chair", "Lounge Chair", "Stool", "Dining Chair", "Bench", "Footrest"] },
  { name: "Storage", band: [59, 549], types: ["Shelf Unit", "File Cabinet", "Storage Crate", "Wall Rack", "Drawer Tower", "Sideboard"] },
  { name: "Audio", band: [49, 879], types: ["Bookshelf Speaker", "Turntable", "Headphones", "Sound Bar", "Desk Speaker", "Amplifier"] },
  { name: "Kitchen", band: [19, 189], types: ["Pour-Over Kettle", "Chef Knife", "Cutting Board", "Mixing Bowl Set", "Cast Pan", "Spice Rack"] },
  { name: "Textiles", band: [25, 249], types: ["Wool Throw", "Linen Cushion", "Area Rug", "Table Runner", "Curtain Panel", "Floor Mat"] },
  { name: "Outdoor", band: [29, 219], types: ["Folding Chair", "Planter Box", "Garden Stool", "Watering Can", "Patio Lantern", "Trellis"] },
];

const MATERIALS = [
  "Anodised aluminium", "Powder-coated steel", "Solid white oak", "Walnut veneer",
  "Recycled polymer", "Brushed brass", "Stoneware", "Cork composite",
  "Bamboo laminate", "Cast iron",
];

const FINISHES = ["Matte black", "Warm white", "Sage", "Sand", "Slate", "Oxblood", "Natural", "Ink blue"];

const DESC_A = [
  "Built for daily use and sized to disappear into a working room.",
  "A quiet, unfussy piece that holds up to years of handling.",
  "Designed around one job and stripped of everything else.",
  "Solid where it needs to be, light everywhere it does not.",
  "Assembled from parts we can replace individually.",
];

const DESC_B = [
  "Ships flat with the hardware you need and nothing you do not.",
  "Finished by hand, so expect small variation between units.",
  "Tested to twice its rated load before it left the workshop.",
  "Compatible with the rest of the range without adapters.",
  "Backed by a repair service rather than a replacement policy.",
];

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function money(rand, min, max) {
  const cents = Math.floor(rand() * (max - min) * 100) + min * 100;
  // Land on believable price points rather than uniform noise.
  const rounded = Math.round(cents / 100) * 100 - 1 + (rand() < 0.5 ? 1 : 0);
  return (Math.max(rounded, min * 100) / 100).toFixed(2);
}

function isoDate(rand) {
  const start = Date.UTC(2022, 0, 1);
  const end = Date.UTC(2025, 10, 30);
  return new Date(start + rand() * (end - start)).toISOString().slice(0, 10);
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function generateItems(count, seed) {
  const rand = rng(seed);
  const items = [];
  const seen = new Set();

  for (let i = 0; i < count; i += 1) {
    const category = pick(rand, CATEGORIES);
    const title = `${pick(rand, PREFIXES)} ${pick(rand, category.types)}`;

    let slug = slugify(title);
    if (seen.has(slug)) {
      let n = 2;
      while (seen.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    seen.add(slug);

    const price = money(rand, category.band[0], category.band[1]);
    const discounted = rand() < 0.25;
    const priceWas = discounted
      ? (Number(price) * (1.2 + rand() * 0.3)).toFixed(2)
      : null;

    const inStock = rand() < 0.875;
    const low = inStock && rand() < 0.2;

    items.push({
      slug,
      title,
      brand: pick(rand, ["Northform", "Lumen Works", "Aster Supply", "Brightline", "Havenwood", "Meridian Goods", "Foldcraft", "Kestrel & Co"]),
      category: category.name,
      sku: `SKU-${1000 + i * 7 + Math.floor(rand() * 6)}`,
      price,
      priceWas,
      currency: "USD",
      rating: (3.4 + rand() * 1.5).toFixed(1),
      reviewCount: 3 + Math.floor(rand() * 2400),
      inStock,
      stockLabel: inStock ? (low ? "Low stock" : "In stock") : "Out of stock",
      description: `${pick(rand, DESC_A)} ${pick(rand, DESC_B)}`,
      released: isoDate(rand),
      specs: {
        Weight: `${(0.3 + rand() * 24).toFixed(1)} kg`,
        Dimensions: `${20 + Math.floor(rand() * 120)} × ${15 + Math.floor(rand() * 80)} × ${10 + Math.floor(rand() * 90)} cm`,
        Material: pick(rand, MATERIALS),
        Finish: pick(rand, FINISHES),
        Warranty: pick(rand, ["1 year", "2 years", "5 years", "10 years", "Lifetime"]),
      },
    });
  }

  return items;
}

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(arg("count", "150"));
  const seed = Number(arg("seed", "1"));
  const out = resolve(HERE, arg("out", "data/items.json"));

  if (!Number.isInteger(count) || count < 1) {
    console.error(`--count must be a positive integer, got ${JSON.stringify(arg("count", ""))}`);
    process.exit(1);
  }
  if (!Number.isInteger(seed)) {
    console.error(`--seed must be an integer, got ${JSON.stringify(arg("seed", ""))}`);
    process.exit(1);
  }

  const items = generateItems(count, seed);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  console.log(`wrote ${items.length} items (seed ${seed}) → ${out}`);
}
