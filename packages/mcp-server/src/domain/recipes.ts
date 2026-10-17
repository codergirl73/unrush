/**
 * A small seeded recipe library for suggest_quick_meal. Quantities are for 2 people
 * and use the same item names/units as the seeded pantry so matching is exact.
 */
export interface RecipeIngredient {
  item: string;
  quantity?: number;
  unit?: string;
}

export interface Recipe {
  id: string;
  name: string;
  prep_minutes: number;
  tags: string[];
  ingredients: RecipeIngredient[];
}

export const RECIPES: Recipe[] = [
  {
    id: "tomato-garlic-spaghetti",
    name: "Tomato & garlic spaghetti",
    prep_minutes: 15,
    tags: ["vegetarian", "pantry"],
    ingredients: [
      { item: "spaghetti", quantity: 200, unit: "g" },
      { item: "canned tomatoes", quantity: 1, unit: "can" },
      { item: "garlic", quantity: 3, unit: "clove" },
      { item: "olive oil", quantity: 30, unit: "ml" },
      { item: "cheddar cheese", quantity: 40, unit: "g" },
    ],
  },
  {
    id: "egg-fried-rice",
    name: "Egg fried rice",
    prep_minutes: 15,
    tags: ["vegetarian"],
    ingredients: [
      { item: "basmati rice", quantity: 200, unit: "g" },
      { item: "egg", quantity: 3 },
      { item: "frozen peas", quantity: 100, unit: "g" },
      { item: "soy sauce", quantity: 30, unit: "ml" },
    ],
  },
  {
    id: "spinach-omelette",
    name: "Spinach & cheddar omelette",
    prep_minutes: 10,
    tags: ["vegetarian"],
    ingredients: [
      { item: "egg", quantity: 4 },
      { item: "baby spinach", quantity: 80, unit: "g" },
      { item: "cheddar cheese", quantity: 50, unit: "g" },
    ],
  },
  {
    id: "bean-quesadillas",
    name: "Black bean quesadillas",
    prep_minutes: 15,
    tags: ["vegetarian"],
    ingredients: [
      { item: "tortilla", quantity: 4 },
      { item: "canned black beans", quantity: 1, unit: "can" },
      { item: "cheddar cheese", quantity: 100, unit: "g" },
      { item: "salsa", quantity: 100, unit: "g" },
    ],
  },
  {
    id: "pesto-pasta",
    name: "Pesto pasta with spinach",
    prep_minutes: 12,
    tags: ["vegetarian"],
    ingredients: [
      { item: "spaghetti", quantity: 200, unit: "g" },
      { item: "pesto", quantity: 100, unit: "g" },
      { item: "baby spinach", quantity: 60, unit: "g" },
    ],
  },
  {
    id: "tuna-melt",
    name: "Tuna melt toasties",
    prep_minutes: 10,
    tags: ["pescatarian"],
    ingredients: [
      { item: "bread", quantity: 4, unit: "slice" },
      { item: "canned tuna", quantity: 1, unit: "can" },
      { item: "cheddar cheese", quantity: 60, unit: "g" },
    ],
  },
  {
    id: "chickpea-spinach-curry",
    name: "Chickpea & spinach curry",
    prep_minutes: 25,
    tags: ["vegan"],
    ingredients: [
      { item: "canned chickpeas", quantity: 1, unit: "can" },
      { item: "coconut milk", quantity: 1, unit: "can" },
      { item: "baby spinach", quantity: 100, unit: "g" },
      { item: "curry powder", quantity: 10, unit: "g" },
      { item: "basmati rice", quantity: 150, unit: "g" },
    ],
  },
  {
    id: "veggie-noodle-stir-fry",
    name: "Veggie noodle stir-fry",
    prep_minutes: 20,
    tags: ["vegan"],
    ingredients: [
      { item: "egg noodle", quantity: 200, unit: "g" },
      { item: "bell pepper", quantity: 1 },
      { item: "carrot", quantity: 1 },
      { item: "soy sauce", quantity: 30, unit: "ml" },
    ],
  },
  {
    id: "red-lentil-soup",
    name: "Red lentil soup",
    prep_minutes: 35,
    tags: ["vegan"],
    ingredients: [
      { item: "red lentils", quantity: 200, unit: "g" },
      { item: "yellow onion", quantity: 1 },
      { item: "carrot", quantity: 2 },
      { item: "vegetable stock", quantity: 750, unit: "ml" },
    ],
  },
  {
    id: "chicken-curry",
    name: "Chicken curry with rice",
    prep_minutes: 45,
    tags: [],
    ingredients: [
      { item: "chicken thigh", quantity: 500, unit: "g" },
      { item: "coconut milk", quantity: 1, unit: "can" },
      { item: "yellow onion", quantity: 1 },
      { item: "canned tomatoes", quantity: 1, unit: "can" },
      { item: "curry powder", quantity: 15, unit: "g" },
      { item: "basmati rice", quantity: 150, unit: "g" },
    ],
  },
];

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}
