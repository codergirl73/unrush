---
name: unrush-evening-rescue
description: Rescue a household evening when plans change. Use when a calendar change squeezes the time before leaving, tonight's planned dinner no longer fits, or staples are running out. Works with the Unrush MCP server tools (compute_leave_by, suggest_quick_meal, save_meal_plan, predict_runouts, build_grocery_order, place_order).
license: MIT
compatibility: Requires the Unrush MCP server (MCP spec 2025-11-25, Streamable HTTP).
metadata:
  author: unrush
  version: "1.0"
---

# Evening rescue

Use this playbook when the evening plan breaks, for example when a meeting runs late. Fix things in this order: get the person out the door on time, then dinner, then groceries. Every reply is spoken aloud, so keep it to one to three short sentences.

## 1. Speak first about time

1. Call `compute_leave_by` for the next event that needs travel.
2. Say what changed and the exact leave-by time, for example: "Your 5:30 meeting now runs to 7. To make your 7:30 plans, leave by 7:05."
3. If `conflict` is true, say how many minutes it overlaps and suggest leaving the meeting early.

## 2. Fix dinner if it no longer fits

1. If tonight's dinner takes longer than the free time, call `suggest_quick_meal` with `max_minutes` set to the suggested value (usually 15).
2. Offer the top suggestion by name and time. Prefer `can_make_now: true`. If it is missing items, say which ones.
3. Ask one yes/no question ("Want me to swap it in?"). Do not change the plan yet.
4. Only after the person agrees, call `save_meal_plan` with `{date: tonight, recipe_id}`.

## 3. Groceries

Do this in the same turn as the dinner swap:

1. Call `build_grocery_order`. It already includes what's out and what's predicted to run out (see each item's reasons), using the household's usual store products. Mention at most two items with the reason ("milk runs out tomorrow").
2. If `needs_choice` lists items (no purchase history), ask which product they want, with short names and prices, in one question. On their answer, call `choose_product` with the matching `asin`.
3. Read `read_back` in one sentence, then ask exactly: "Shall I place the order?"

## 4. Place the order only on an explicit yes

- Call `place_order` with `confirmed: true` **only** if the person's latest message is a clear yes to "Shall I place the order?". See [references/consent.md](references/consent.md).
- Then say the simulated confirmation number and ETA, and that each product is linked on screen to its Amazon page. Unrush never pays: the person adds items to their Amazon cart and checks out themselves.
- If they hesitate or say anything other than yes, do not order. Offer to change the list instead.

## Don'ts

- Don't guess times, pantry contents or dates. Always use the tools.
- Don't read whole lists aloud. The details are on screen.
- Don't place orders or change plans during a proactive turn. Propose and ask instead.
