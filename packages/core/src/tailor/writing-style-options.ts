/**
 * The writing style's choices and limits, with no imports so the renderer can read them without
 * pulling zod or the prompts in (`writing-style.ts` holds the schema and the prompt block).
 */

export const WRITING_TONES = ["plain", "formal", "warm"] as const;
export type WritingTone = (typeof WRITING_TONES)[number];

/** The cover letter's length, always inside the fixed 220 to 400 word rule. */
export const LETTER_LENGTHS = ["shorter", "standard", "fuller"] as const;
export type LetterLength = (typeof LETTER_LENGTHS)[number];

/** Words to avoid: a short list, not a second banned list. */
export const AVOID_WORDS_MAX = 30;
export const AVOID_WORD_CHARS = 40;
/** The guidance box: a few lines of "always/never", not a second posting. */
export const GUIDANCE_CHARS = 1000;
