/** Map a (normalized) item name to a grocery-store section by keyword. */

export const SECTIONS = [
  "Produce",
  "Dairy & Eggs",
  "Meat & Seafood",
  "Bakery",
  "Pantry Staples",
  "Spices & Condiments",
  "Frozen",
  "Beverages",
  "Other",
] as const;

export type Section = (typeof SECTIONS)[number];

const KEYWORDS: Array<[Section, string[]]> = [
  ["Frozen", ["frozen", "ice cream"]],
  ["Spices & Condiments", [
    "salt", "pepper flake", "black pepper", "cumin", "paprika", "turmeric", "oregano", "basil dried",
    "cinnamon", "chili powder", "garam masala", "curry powder", "soy sauce", "vinegar", "mustard",
    "ketchup", "mayo", "mayonnaise", "hot sauce", "sriracha", "honey", "maple syrup", "spice",
    "seasoning", "stock cube", "bouillon", "miso", "tahini", "pesto", "salsa", "fish sauce", "vanilla",
  ]],
  ["Dairy & Eggs", [
    "milk", "cheese", "cheddar", "mozzarella", "parmesan", "feta", "paneer", "butter", "yogurt",
    "yoghurt", "cream", "egg", "ricotta", "halloumi", "ghee",
  ]],
  ["Meat & Seafood", [
    "chicken", "beef", "pork", "bacon", "sausage", "turkey", "lamb", "ham", "salmon", "tuna",
    "shrimp", "prawn", "cod", "fish", "mince", "steak",
  ]],
  ["Bakery", ["bread", "baguette", "bun", "roll", "tortilla", "pita", "naan", "bagel", "croissant", "wrap"]],
  ["Beverages", ["juice", "coffee", "tea", "soda", "sparkling water", "wine", "beer"]],
  ["Pantry Staples", [
    "rice", "pasta", "spaghetti", "penne", "noodle", "flour", "sugar", "oil", "olive oil", "oat",
    "lentil", "chickpea", "bean", "quinoa", "couscous", "canned", "tomato paste", "passata",
    "coconut milk", "stock", "broth", "chicken stock", "chicken broth", "beef stock", "vegetable stock", "cornstarch", "nut", "peanut butter", "cereal", "breadcrumb", "tofu",
    "tempeh", "baking", "yeast", "cracker",
  ]],
  ["Produce", [
    "apple", "banana", "lemon", "lime", "orange", "berry", "grape", "avocado", "tomato", "onion",
    "garlic", "ginger", "potato", "carrot", "celery", "pepper", "lettuce", "spinach", "kale",
    "cucumber", "zucchini", "courgette", "broccoli", "cauliflower", "mushroom", "herb", "cilantro",
    "coriander", "parsley", "basil", "mint", "scallion", "spring onion", "leek", "squash", "pumpkin",
    "corn", "pea", "green", "cabbage", "eggplant", "aubergine", "asparagus", "sweet potato", "chili",
    "chilli", "shallot", "radish", "beet", "mango", "pear", "peach", "salad", "arugula", "rocket",
    "rosemary", "thyme", "dill", "sage", "chive", "tarragon", "fennel", "okra", "bok choy", "edamame",
  ]],
];

export function sectionFor(item: string): Section {
  const name = item.toLowerCase();
  // Longest matching keyword wins so "coconut milk" beats "milk" and "sweet potato" beats "potato".
  let best: { section: Section; len: number } | undefined;
  for (const [section, words] of KEYWORDS) {
    for (const w of words) {
      if (matches(name, w) && (!best || w.length > best.len)) best = { section, len: w.length };
    }
  }
  return best?.section ?? "Other";
}

function matches(name: string, keyword: string): boolean {
  // whole-word-ish match: keyword at a word boundary (allows trailing plural/suffix)
  const re = new RegExp(`(^|\\s)${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  return re.test(name);
}
