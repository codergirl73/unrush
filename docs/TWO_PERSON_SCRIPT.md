# Unrush: two-person recording script (about 2:45)

Two people, one take, one screen. **Person A (Host)** narrates and drives the mouse. **Person B (Maya)** is the user and talks to Unrush out loud. Unrush answers in its own voice, so the video has three voices without any editing.

## Before you record (5 minutes)

- Run `npm run dev` with real Bedrock (`AWS_REGION` and `BEDROCK_MODEL_ID` in `.env`). Open http://localhost:5173 in Chrome at 1920×1080, light mode, **Voice on**.
- **Mic:** Person B needs a working mic in Chrome (allow it when asked). Hold the orb, or hold **Space** when the cursor isn't in the text box, to talk.
- **Echo:** Unrush speaks through the laptop speaker, and the mic can hear it. Person B should only press and hold the orb *after* Unrush has finished talking.
- **Audio:** record the screen with both voices and Unrush's speaker in one place. In one room, use one decent mic (or the laptop mic) between you. Remotely, share the screen with computer audio in Zoom or Meet and record there.
- Click **Start over** so the demo day is back at 3pm. Do one dry run, then **Start over** again.
- Person A keeps the mouse. Person B sits next to the mic and keeps their hands free for the Space bar.

## The script

Say the lines in **bold** in your own words if you like. Unrush's replies are from the live model, so they vary a little; the beats don't.

| Time | Screen / action | Person A (Host) | Person B (Maya) |
|---|---|---|---|
| **0:00** | The app at 3pm. Point at the timeline: Project sync 5:30, Study group 7:30, curry planned | **"This is Unrush, an assistant that speaks first, before your evening falls apart. It's 3pm."** | **"I've got a project call at five thirty, study group across town at seven thirty, and I'm cooking a curry in between."** |
| **0:20** | A clicks **Make the meeting run late** | **"Now her call gets pushed. It runs until seven."** | *(quiet, watching)* |
| **0:28** | The banner drops in and Unrush speaks first: leave by 7:05, curry won't fit, swap to the spaghetti? *(A: wait for it to finish, about 15 s)* | *(silent while Unrush talks)* | *(silent)* |
| **0:45** | Point at the Agent activity panel (`suggest_quick_meal`) | **"Nobody asked. It noticed the conflict, worked out when to leave and found a dinner that fits, using tools on its own MCP server."** | **"Oh wow. Yes please."** (hold the orb or Space) |
| **0:58** | Dinner card flips to the spaghetti; the order fills in. Unrush asks which pesto and names three. *(wait for it to finish)* | **"It swapped dinner, noticed eggs are out and milk runs out tomorrow, picked her usual products, and asks only about the new one."** | **"For pesto, I'll take the Amazon Grocery Basil Pesto."** (hold the orb) |
| **1:30** | Unrush reads the order back: "Shall I place the order?" | **"Nothing is bought without an explicit yes. The tool refuses unless confirmed is true."** | **"Yes, place the order."** (hold the orb) |
| **1:50** | Order placed, SIM- number. A scrolls to the four Amazon product links | **"Checkout is simulated, but every product links to its real Amazon page, so she adds it to her cart herself. Unrush never sees card details."** | **"And I can still open them myself. Nice."** |
| **2:10** | Point at Agent activity: `choose_product`, `place_order confirmed: true` | **"Every step is a real Amazon Bedrock call driving tools on our own MCP server, spec 2025-11-25, over Streamable HTTP."** | *(quiet)* |
| **2:25** | A clicks **MCP Apps**: the same cards from the server's `ui://` views | **"The same cards ship from the server as MCP Apps, so any MCP Apps host can show them."** | *(quiet)* |
| **2:35** | A reloads the page. "Welcome back, I still remember…" | **"Reload, or restart the server, and Unrush still remembers. State lives in the MCP server, the conversation in AgentCore Memory."** | **"It remembered my order."** |
| **2:50** | Hold on the repo | **"Unrush. It speaks first, so your evening doesn't fall apart."** | **"Link's in the description."** |

## If something goes wrong

- **The mic mishears Maya:** click the matching reply chip under the conversation instead (it says the same words). It's still a real turn.
- **Unrush takes longer than usual:** keep the pause. Person A can say **"Real Bedrock calls take a few seconds."** Cut it later if needed.
- **Unrush's reply names a different dinner or product:** keep going if it matches the screen; otherwise **Start over** and retake from the top.
- **A line comes out wrong:** pause for three seconds, then repeat it. It's easy to trim.
- **Bedrock is unavailable:** Unrush still speaks first, using the alert text. Don't use `npm run dev:offline` for the final take; it isn't Bedrock.

## After the take

Check it's under three minutes, trim the dead air, and export at 1080p. Devpost needs a YouTube, Vimeo or Youku link, so upload the file there and paste the link.
