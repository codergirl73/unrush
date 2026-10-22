/**
 * Store products Unrush can put in a real Amazon cart. Amazon's own grocery brands
 * only (Amazon Grocery, 365 by Whole Foods Market), so no third-party brands
 * appear. ASINs, titles and prices were read from amazon.com search results on
 * 2026-10-22; prices are a snapshot for estimates and the cart shows live ones.
 *
 * The cart itself is Amazon's documented add-to-cart link: opening it shows
 * Amazon's own confirmation page, and the user reviews and checks out there.
 * Unrush never places a real order and never sees payment details.
 */
import { toCanonical } from "../units.js";

export interface Product {
  asin: string;
  item: string;
  title: string;
  /** One pack, e.g. 64 fl oz, as the store sells it. */
  pack: { quantity: number; unit: string };
  price_usd: number;
}

const p = (asin: string, item: string, title: string, quantity: number, unit: string, price_usd: number): Product => ({
  asin,
  item,
  title,
  pack: { quantity, unit },
  price_usd,
});

export const CATALOG: Product[] = [
  p("B07YSWG9WS", "whole milk", "Amazon Grocery Whole Milk, Half Gallon (64 fl oz)", 1.89, "l", 2.62),
  p("B07YSWTL27", "whole milk", "Amazon Grocery Whole Milk, Gallon (128 fl oz)", 3.79, "l", 5.09),
  p("B07GBM7TZJ", "egg", "Amazon Grocery Cage-Free Large White Eggs, 1 Dozen", 12, "count", 2.59),
  p("B07GBLQF6H", "egg", "Amazon Grocery Cage-Free Large Brown Eggs, 1 Dozen", 12, "count", 2.96),
  p("B074H4WRNG", "baby spinach", "365 by Whole Foods Market Organic Baby Spinach, 5 oz", 142, "g", 3.18),
  p("B074H55NJK", "baby spinach", "365 by Whole Foods Market Organic Baby Spinach, 16 oz", 454, "g", 6.29),
  p("B0CS56H5HL", "pesto", "Amazon Grocery Basil Pesto, 8 oz", 227, "g", 3.5),
  p("B085DTX3K8", "pesto", "365 by Whole Foods Market Basil Pesto Sauce, 5.5 oz", 156, "g", 6.49),
  p("B08KT6N4SH", "pesto", "Whole Foods Market Vegan Tomato Pesto, 6.7 oz", 190, "g", 3.99),
];

export function productsFor(item: string): Product[] {
  return CATALOG.filter((x) => x.item === item);
}

export function productByAsin(asin: string): Product | undefined {
  return CATALOG.find((x) => x.asin === asin);
}

/** How many packs cover a quantity (at least one). */
export function packsFor(product: Product, quantity: number | null, unit: string | null): number {
  if (quantity === null) return 1;
  const need = toCanonical(quantity, unit);
  const pack = toCanonical(product.pack.quantity, product.pack.unit);
  if (need.unit !== pack.unit || pack.quantity <= 0) return 1;
  return Math.max(1, Math.round(need.quantity / pack.quantity));
}

/** Amazon's documented add-to-cart link (ASIN.n / Quantity.n). */
export function amazonCartUrl(lines: Array<{ asin: string; packs: number }>): string | null {
  if (lines.length === 0) return null;
  const params = lines.map((l, i) => `ASIN.${i + 1}=${encodeURIComponent(l.asin)}&Quantity.${i + 1}=${l.packs}`).join("&");
  return `https://www.amazon.com/gp/aws/cart/add.html?${params}`;
}

/** Search link for items the catalog doesn't cover. */
export function amazonSearchUrl(item: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(item)}&i=amazonfresh`;
}
