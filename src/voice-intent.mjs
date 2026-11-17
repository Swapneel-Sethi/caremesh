// Voice intent classification for the CarePulse AI check-in.
//
// Deliberately small and conservative: only a bounded set of care coordination
// intents is recognised. It never attempts unrestricted medical interpretation. If a phrase is
// not clearly one of these, the answer is UNCLEAR so the workflow escalates to a
// human caregiver instead of guessing.

const DIGIT_INTENTS = {
  '1': 'TAKEN',
  '2': 'NOT_TAKEN',
  '3': 'HELP'
};

const HELP_PATTERN = /\b(i need help|need help|help me|call me|need someone|someone to help|ask my caregiver|call my caregiver|my caregiver|caregiver|help)\b/;
const NOT_TAKEN_PATTERN = /\b(no(?!\s+(problem|worries))|nope|not yet|not taken|have not|has not|haven'?t|hasn'?t|didn'?t|did not|forgot|forget|skipped|missed)\b/;
const TAKEN_PATTERN = /\b(yes|yeah|yep|yup|i took|took it|took them|taken|already took|already taken|i did|did take|confirmed|confirm)\b/;

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function classifyVoiceIntent(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { intent: 'UNCLEAR', confidence: 0, model: 'deterministic' };
  }

  const trimmed = text.trim();
  if (DIGIT_INTENTS[trimmed]) {
    return { intent: DIGIT_INTENTS[trimmed], confidence: 0.99, model: 'dtmf' };
  }

  const normalised = normalise(trimmed);
  if (!normalised) return { intent: 'UNCLEAR', confidence: 0, model: 'deterministic' };

  // Order matters. "I need help" must win over the word "no" in a longer
  // sentence, and "I haven't taken it" must be read as NOT_TAKEN before the
  // word "taken" can look like a confirmation.
  if (HELP_PATTERN.test(normalised)) {
    return { intent: 'HELP', confidence: 0.95, model: 'deterministic' };
  }
  if (NOT_TAKEN_PATTERN.test(normalised)) {
    return { intent: 'NOT_TAKEN', confidence: 0.9, model: 'deterministic' };
  }
  if (TAKEN_PATTERN.test(normalised)) {
    return { intent: 'TAKEN', confidence: 0.9, model: 'deterministic' };
  }

  return { intent: 'UNCLEAR', confidence: 0.1, model: 'deterministic' };
}
