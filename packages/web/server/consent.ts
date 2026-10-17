/**
 * "Nothing is bought without an explicit yes." The backend only lets place_order
 * through when the assistant's previous turn asked about placing the order AND
 * the user's reply is an unambiguous yes. The MCP server separately refuses
 * unless confirmed=true; this check stops a model from setting that on its own.
 */
const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|please do|do it|place it|place the order|order it|confirm(ed)?|sounds good)\b/i;
const NO = /\b(no|nope|don'?t|do not|not yet|wait|hold on|cancel|stop|never ?mind)\b/i;
const ASKED = /\b(place|order|checkout|buy)\b/i;

export function isExplicitYes(userText: string): boolean {
  return YES.test(userText) && !NO.test(userText);
}

export function allowsOrder(lastAssistant: string | undefined, userText: string): boolean {
  return !!lastAssistant && ASKED.test(lastAssistant) && /\?/.test(lastAssistant) && isExplicitYes(userText);
}
