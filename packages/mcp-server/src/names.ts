/**
 * Item-name normalization so "Eggs", "egg" and " EGGS " all hit the same pantry row.
 * Deliberately simple: lowercase, collapse whitespace, naive singularization with
 * an exception list for words that end in "s" but aren't plural.
 */

// Words ending in "s" that are not plurals. Countable plurals (peas, beans, oats…)
// are deliberately singularized so "pea" and "peas" hit the same pantry row.
const NOT_PLURAL = new Set([
  "hummus", "couscous", "asparagus", "molasses", "swiss", "brussels", "citrus",
  "grits", "bass", "glass", "watercress", "cress", "swiss chard", "harissa",
]);

const IRREGULAR: Record<string, string> = {
  leaves: "leaf",
  loaves: "loaf",
  knives: "knife",
  potatoes: "potato",
  tomatoes: "tomato",
  mangoes: "mango",
};

export function normalizeItemName(raw: string): string {
  // Drop leading articles/possessives a model might include ("the eggs", "my milk").
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/^(?:(?:the|a|an|my|our|some|any)\s+)+/, "");
  if (!s) return s;
  const words = s.split(" ");
  const last = words[words.length - 1]!;
  words[words.length - 1] = singularize(last, s);
  return words.join(" ");
}

function singularize(word: string, phrase: string): string {
  if (NOT_PLURAL.has(word) || NOT_PLURAL.has(phrase)) return word;
  if (IRREGULAR[word]) return IRREGULAR[word]!;
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}
