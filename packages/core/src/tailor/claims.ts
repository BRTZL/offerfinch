// Public claims-check entry point. Implementation is split by responsibility.
export {
	type KnownExpansion,
	profileExpansions,
	TRUSTED_EXPANSIONS,
	trustedExpansion,
	withoutExpansions,
} from "./claims/expansions";
export { unsupportedNumbers } from "./claims/numbers-employers";
export {
	buildClaimsPrompt,
	claimsPromptParts,
	SYSTEM_PROMPT,
	untrustedText,
} from "./claims/schema-prompt";
export {
	checkedSegments,
	type LineContext,
	lineContexts,
	type Segment,
	segmentDocuments,
	segmentKey,
} from "./claims/segments";
export {
	type CandidateSide,
	candidateSide,
	skippable,
} from "./claims/skippable";
export { factTokens, overlap, scopeTokens } from "./claims/tokens";
export {
	CHECKED_DOCUMENTS,
	type CheckedClaim,
	type CheckedDocument,
	type ClaimsCheckOutput,
	type ClaimsInput,
	type ClaimsReport,
	claimsCheckSchema,
	SKIP_CATEGORIES,
} from "./claims/types";
export {
	checkClaims,
	checkRulesOnly,
	clearedFlags,
	focusedInput,
	type StoredFlag,
	verifyClaims,
} from "./claims/verify";
