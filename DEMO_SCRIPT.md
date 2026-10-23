# Unrush: demo video script (2:59)

The recorded video is [docs/media/unrush-demo.mp4](docs/media/unrush-demo.mp4). It was made from a live run on Amazon Bedrock (Nova 2 Lite) with AgentCore Memory, driven through the app's guided demo. Unrush's lines are its real replies from that run, voiced. Timings are from the final cut.

| Time | On screen | Voice |
|---|---|---|
| **0:00** | Title card: Unrush, the tagline, and what it's built with | Narrator: "This is Unrush: a household assistant that speaks first, before your evening falls apart." |
| **0:09** | The app at 3pm. Spotlight on the evening timeline: Project sync 5:30, Study group 7:30 at the Library, a 45-min curry | Narrator: "It's three in the afternoon. Maya has a project call at five thirty, a study group across town at seven thirty, and a forty-five minute curry planned for dinner." |
| **0:20** | Click **Make the meeting run late** | Narrator: "Then her call gets pushed. It now runs until seven." |
| **0:24** | The banner drops in: **Unrush speaks first**. The timeline shows the meeting stretched, with **Leave by 7:05pm**; the dinner card says **Won't fit** | Unrush (its real reply): leave by 7:05, the curry won't fit, swap in Tomato & garlic spaghetti (15 min, all in the pantry)? |
| **0:44** | Spotlight on Agent activity: `suggest_quick_meal` → Bedrock Converse → AgentCore Memory save | Narrator: "Nobody asked. Unrush noticed the conflict, worked out when to leave, and found a dinner that fits, using tools on its own MCP server." |
| **0:51** | Click **Say "Yes please"**. The dinner card flips to the spaghetti; the grocery order fills in with "your usual" products | Unrush: asks which pesto, naming the three real products |
| **1:15** | Spotlight on the cards | Narrator: "It saved the swap, then checked the kitchen. Eggs are out, and milk runs out tomorrow, predicted from six weeks of purchases. It picked Maya's usual products, and only asks about the one it doesn't know." |
| **1:28** | Click the **Amazon Grocery Basil Pesto** reply | Unrush: reads the draft order back and asks "Shall I place the order?" |
| **1:42** | Spotlight on the guide (step 4, Confirm the order) | Narrator: "Nothing is bought without an explicit yes. The tool refuses unless confirmed is true, and the backend checks that she really said yes." |
| **1:51** | Click **Say "Yes, place the order."** | Unrush: order placed with a SIM- confirmation number; each item is linked on screen |
| **2:06** | Scroll to **Order placed**; spotlight on the four Amazon product links | Narrator: "The checkout is simulated, but every product links to its real Amazon page, so she adds it to her cart herself. Unrush never sees card details." |
| **2:15** | Spotlight on Agent activity (`choose_product`, `place_order confirmed: true`, token counts) | Narrator: "Every step you saw is a real Amazon Bedrock Converse call, driving tools on a self-hosted MCP server, spec 2025-11-25, over Streamable HTTP." |
| **2:28** | Click **MCP Apps**: the same cards rendered from the server's `ui://` views | Narrator: "The same cards also ship from the server as MCP Apps, so any MCP Apps host can render them." |
| **2:37** | Reload the page: **Welcome back**, everything restored | Narrator: "Reload the page, or restart the server, and Unrush still remembers. Household state lives in the MCP server, and the conversation in Amazon Bedrock AgentCore Memory." |
| **2:51** | Outro: how it works (browser ⇄ agent backend ⇄ MCP server) and the repo link | Narrator: "Unrush. It speaks first, so your evening doesn't fall apart." |

## Re-record it

`scripts/demo-video/` makes the video from a live run, with no screen-recording permission needed:

```bash
npm run dev                                  # in one terminal (real Bedrock: AWS_REGION and BEDROCK_MODEL_ID in .env)
node scripts/demo-video/record.mjs           # ~3 min: drives headless Chrome at 1920x1080 through the guided demo
node scripts/demo-video/assemble.mjs         # writes scripts/demo-video/out/unrush-demo.mp4
```

- **What's needed:** macOS (it uses `say` for the voices), Google Chrome and ffmpeg (`brew install ffmpeg`).
- **How it records:**
  - Chrome is driven over its DevTools protocol, using Node's built-in WebSocket, with no packages.
  - A visible cursor clicks the real buttons. Spotlights and subtitles are drawn on top of the page.
  - Waits for the model are cut to under a second; everything else plays in real time.
- **Voices:** the narrator is Daniel, Unrush is Samantha (the voice Chrome uses on a Mac). You can change them at the top of `record.mjs`. Installing an Enhanced voice (System Settings › Accessibility › Spoken Content) sounds noticeably better.
- **Length:** Bedrock's replies differ a little from run to run, so the length does too. Check that the final cut is under 3:00.

## Recording it live yourself

- Run `npm run dev`, open http://localhost:5173 in Chrome at 1920×1080 in light mode with the voice on, then click **Start over**.
- Follow the step bar under the header. The reply chips under the conversation give you the next thing to say, or hold the orb (or Space) and say it.
- If Bedrock is unavailable, Unrush still speaks first using the alert text the MCP server wrote. `npm run dev:offline` rehearses without AWS and is labelled as not Bedrock. Don't use it for the final take.
