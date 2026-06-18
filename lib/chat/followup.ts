/**
 * Follow-up resolution from recent chat history.
 *
 * Field users ask short references that only make sense against the previous
 * turn: "Du har bemanningsplanen. sjekk den", "bruk bemanningsplanen",
 * "hva med august?", "kan du regne på det?". On their own these carry no
 * demand or subject, so retrieval and intent detection fail.
 *
 * This module decides whether the latest message is such a follow-up and, if so,
 * produces a richer *retrieval text* by combining it with the most recent
 * substantive user question from history. Only the retrieval text is enriched —
 * the original message is still what the user sees and what we answer to. History
 * is used transiently and never stored or logged in full.
 *
 * Pure and dependency-free for easy testing.
 */

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ResolvedQuery {
  /** Text to drive intent detection + document search (enriched for follow-ups). */
  retrievalText: string;
  /** The prior user question a follow-up refers to, if any. */
  priorQuestion: string | null;
  /** True when the latest message was treated as a follow-up reference. */
  isFollowUp: boolean;
}

/**
 * Strong references: these explicitly point at the document/prior turn ("sjekk
 * den", "bruk bemanningsplanen", "du har dokumentet"), so they are always
 * follow-ups regardless of length.
 */
const STRONG_PATTERNS: RegExp[] = [
  /\bsjekk\s+(den|det|dokumentet|planen|bemanningsplanen)\b/i,
  /\bbruk\s+(den|det|dokumentet|planen|bemanningsplanen)\b/i,
  /\bdu\s+har\s+(den|det|dokumentet|planen|bemanningsplanen)\b/i,
  /\bse\s+(på\s+)?(den|det|dokumentet|planen|bemanningsplanen)\b/i,
  /\b(kan\s+du\s+)?regne\s+på\s+(det|den|dette)\b/i,
];

/**
 * Weak references ("hva med august?", "har vi nok folk?", "og da?"): only a
 * follow-up when the message is short / carries no demand of its own — otherwise
 * a full self-contained question like "Har vi kapasitet …?" would be misread.
 */
const WEAK_PATTERNS: RegExp[] = [
  /\bhva\s+med\s+\w+\??$/i,
  /\bhar\s+vi\s+(nok|kapasitet)\b/i,
  /\bog\s+(da|nå)\b/i,
];

/** Short, demonstrative-only messages ("sjekk den", "ja", "og august?"). */
function isShortReference(message: string): boolean {
  const words = message.trim().split(/\s+/);
  if (words.length > 6) return false;
  return /\b(den|det|dette|dokumentet|planen|bemanningsplanen)\b/i.test(message);
}

/** A message is "substantive" if it carries enough to retrieve against. */
function isSubstantive(content: string): boolean {
  if (content.trim().split(/\s+/).length >= 8) return true;
  // Numbers, percentages or hours usually mean a concrete demand was stated.
  return /\d/.test(content);
}

/** True when the message looks like a follow-up that needs prior context. */
export function isFollowUp(message: string): boolean {
  if (STRONG_PATTERNS.some((re) => re.test(message))) return true;
  if (isShortReference(message)) return true;
  // Weak patterns only count for short, non-substantive messages.
  return !isSubstantive(message) && WEAK_PATTERNS.some((re) => re.test(message));
}

/**
 * Resolve the latest message against recent history. When it is a follow-up,
 * the retrieval text becomes "<prior substantive question> <latest message>" so
 * intent detection and document search see the full context.
 */
export function resolveFollowUp(
  message: string,
  history: ChatHistoryMessage[] = [],
): ResolvedQuery {
  const followUp = isFollowUp(message);
  if (!followUp) {
    return { retrievalText: message, priorQuestion: null, isFollowUp: false };
  }

  // Most recent substantive *user* turn before the current message.
  const priorUserMessages = history.filter((m) => m.role === "user");
  let priorQuestion: string | null = null;
  for (let i = priorUserMessages.length - 1; i >= 0; i--) {
    const content = priorUserMessages[i].content.trim();
    if (content && content !== message.trim() && isSubstantive(content)) {
      priorQuestion = content;
      break;
    }
  }

  if (!priorQuestion) {
    return { retrievalText: message, priorQuestion: null, isFollowUp: true };
  }

  return {
    retrievalText: `${priorQuestion} ${message}`.trim(),
    priorQuestion,
    isFollowUp: true,
  };
}
