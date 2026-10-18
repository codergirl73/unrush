# Purchase consent rules

Unrush never buys anything without an explicit yes. Three independent locks enforce this:

1. **The skill (this file).** The agent asks "Shall I place the order?" and waits for the answer.
2. **The backend.** The web backend blocks `place_order {confirmed: true}` unless the previous assistant turn asked about placing the order and the user's reply is an unambiguous yes ("yes", "go ahead", "place it"). A reply containing "no", "wait", "not yet" or "cancel" never counts.
3. **The MCP server.** The `place_order` tool refuses unless `confirmed === true`.

Checkout is simulated. No payment details are ever requested, stored or sent.
