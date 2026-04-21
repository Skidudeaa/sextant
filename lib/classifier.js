// ARCHITECTURE: Prompt classifier for query-aware retrieval.
// WHY: The hook needs to decide in <1ms whether the user's prompt warrants
//      a search, and extract useful search terms if so. This runs on every
//      UserPromptSubmit — speed and false-positive avoidance are paramount.
// TRADEOFF: Conservative threshold (score >= 3) means some borderline prompts
//           won't trigger retrieval, but false positives that inject irrelevant
//           context are worse than missed retrievals (user can always search manually).

"use strict";

// --- Identifier shape detection ---

// WHY: camelCase, PascalCase, snake_case, CONST_CASE are strong signals that
// the prompt references code symbols. These are checked BEFORE term extraction
// because even single-word identifiers like "rerankFiles" should trigger retrieval.

function hasIdentifierShape(token) {
  if (!token || token.length < 2) return false;
  // camelCase: lowercase letter followed later by uppercase (e.g., rerankFiles)
  if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(token)) return true;
  // PascalCase: starts with uppercase, has at least one lowercase (e.g., MyModel)
  if (/^[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*$/.test(token)) return true;
  // snake_case: lowercase with underscores (e.g., process_data)
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token)) return true;
  // CONST_CASE: uppercase with underscores (e.g., MAX_RETRIES)
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(token)) return true;
  // dotted identifier: word.word (e.g., graph.js used as module reference, module.exports)
  // NOTE: Excluded here — file paths are handled by looksLikePath instead
  return false;
}

// --- File path detection ---

const PATH_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".rb", ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".fs",
  ".php", ".lua", ".ex", ".exs", ".erl",
  ".sh", ".bash", ".zsh",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".vue", ".svelte",
  ".sql", ".graphql", ".gql",
  ".md", ".rst", ".txt",
  ".dockerfile", ".tf", ".proto",
]);

function looksLikePath(token) {
  if (!token) return false;
  // Contains a slash — looks like a path (e.g., lib/graph.js, src/utils/)
  if (token.includes("/")) return true;
  // Ends with a known extension (e.g., graph.js, config.yaml)
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = token.slice(dotIdx).toLowerCase();
    if (PATH_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

// --- Skip terms (noise words for search) ---

// WHY: ~200 common English words + action verbs. Action verbs like "fix", "add",
// "update" are useful for SIGNAL DETECTION (they tell us the prompt is about code)
// but useless as SEARCH TERMS (searching for "fix" returns noise). Signal detection
// runs BEFORE term extraction, so these words contribute to the score but are then
// stripped from the terms list.
const SKIP_TERMS = new Set([
  // Articles & determiners
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "our",
  "its", "his", "her", "their", "some", "any", "each", "every", "all", "both",
  "few", "more", "most", "other", "such", "no",
  // Pronouns
  "i", "me", "we", "us", "you", "he", "him", "she", "they", "them", "it",
  "who", "whom", "what", "which", "whose",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about",
  "into", "over", "after", "before", "between", "under", "above", "below",
  "through", "during", "without", "within", "along", "across", "behind",
  "beyond", "around", "toward", "towards",
  // Conjunctions
  "and", "or", "but", "nor", "so", "yet", "as", "if", "when", "while",
  "because", "since", "until", "unless", "although", "though", "whether",
  // Common verbs (non-action — conversational/structural)
  "is", "are", "was", "were", "be", "been", "being", "am",
  "have", "has", "had", "having",
  "do", "does", "did", "doing", "done",
  "will", "would", "shall", "should", "may", "might", "can", "could", "must",
  "get", "got", "getting", "gets",
  "go", "goes", "going", "went", "gone",
  "come", "comes", "coming", "came",
  "make", "makes", "making", "made",
  "take", "takes", "taking", "took", "taken",
  "give", "gives", "giving", "gave", "given",
  "say", "says", "said", "saying",
  "tell", "tells", "told", "telling",
  "know", "knows", "knew", "known", "knowing",
  "think", "thinks", "thought", "thinking",
  "see", "sees", "saw", "seen", "seeing",
  "want", "wants", "wanted", "wanting",
  "use", "uses", "used", "using",
  "try", "tries", "tried", "trying",
  "need", "needs", "needed", "needing",
  "mean", "means", "meant", "meaning",
  "keep", "keeps", "kept", "keeping",
  "let", "lets", "letting",
  "put", "puts", "putting",
  "seem", "seems", "seemed", "seeming",
  "leave", "leaves", "left", "leaving",
  "call", "calls", "called", "calling",
  "work", "works", "worked", "working",
  "run", "runs", "running", "ran",
  "look", "looks", "looked", "looking",
  "turn", "turns", "turned", "turning",
  "help", "helps", "helped", "helping",
  "talk", "talks", "talked", "talking",
  "start", "starts", "started", "starting",
  "read", "reads",
  "write", "writes", "writing", "wrote", "written",
  // Action verbs — signals for detection, noise for search
  // WHY: "fix the resolver" should detect as code-relevant (+3 score) but
  // the search terms should be ["resolver"], not ["fix", "resolver"]
  "fix", "fixes", "fixed", "fixing",
  "add", "adds", "added", "adding",
  "update", "updates", "updated", "updating",
  "change", "changes", "changed", "changing",
  "remove", "removes", "removed", "removing",
  "delete", "deletes", "deleted", "deleting",
  "create", "creates", "created", "creating",
  "move", "moves", "moved", "moving",
  "rename", "renames", "renamed", "renaming",
  "refactor", "refactors", "refactored", "refactoring",
  "implement", "implements", "implemented", "implementing",
  "replace", "replaces", "replaced", "replacing",
  "rewrite", "rewrites", "rewritten", "rewriting",
  "merge", "merges", "merged", "merging",
  "split", "splits", "splitting",
  "extract", "extracts", "extracted", "extracting",
  "convert", "converts", "converted", "converting",
  "modify", "modifies", "modified", "modifying",
  "debug", "debugs", "debugged", "debugging",
  "test", "tests", "tested", "testing",
  "check", "checks", "checked", "checking",
  "verify", "verifies", "verified", "verifying",
  "clean", "cleans", "cleaned", "cleaning",
  "cleanup",
  "optimize", "optimizes", "optimized", "optimizing",
  "improve", "improves", "improved", "improving",
  "handle", "handles", "handled", "handling",
  "set", "sets", "setting",
  "build", "builds", "built", "building",
  "install", "installs", "installed", "installing",
  "enable", "enables", "enabled", "enabling",
  "disable", "disables", "disabled", "disabling",
  "ensure", "ensures", "ensured", "ensuring",
  "find", "finds", "found", "finding",
  "show", "shows", "showed", "showing", "shown",
  "list", "lists", "listed", "listing",
  "print", "prints", "printed", "printing",
  "display", "displays", "displayed", "displaying",
  // Question words (used for signal detection but dropped as terms)
  "where", "how", "why", "when",
  // WHY: "import/export/require" appear in definition queries ("what imports X")
  // as signal words but searching for "imports" itself returns noise.
  "import", "imports", "imported", "importing",
  "export", "exports", "exported", "exporting",
  "require", "requires", "required", "requiring",
  // Conversational meta-verbs (signals for detection, noise for search)
  "explain", "explains", "explained", "explaining",
  "describe", "describes", "described", "describing",
  "summarize", "summarizes", "summarized", "summarizing",
  "overview",
  // Filler / conversational
  "please", "just", "also", "still", "even", "really", "actually", "basically",
  "simply", "only", "already", "maybe", "probably", "definitely", "certainly",
  "like", "thing", "things", "stuff", "something", "everything", "anything",
  "nothing", "way", "ways", "time", "times", "lot", "lots",
  // Time / greeting words (drain conversational prompts like "how are you
  // today" to zero code-relevant terms so they stop tripping retrieval)
  "today", "tomorrow", "yesterday", "tonight", "now", "later", "recently",
  "week", "weeks", "month", "months", "year", "years", "day", "days",
  "hour", "hours", "minute", "minutes", "second", "seconds",
  "morning", "afternoon", "evening", "night",
  "hello", "hi", "hey", "bye", "goodbye", "thanks", "thank",
  "okay", "ok", "sure", "yeah", "yes", "no", "nope",
  // Common adjectives
  "new", "old", "good", "bad", "big", "small", "same", "different",
  "first", "last", "next", "current", "right", "wrong",
  // Meta / task words
  // NOTE: "error", "class", "type", "module", "function", "method" are NOT here —
  // they are legitimate search terms that appear verbatim in codebases. Unlike
  // action verbs ("fix" returns noise), these are precise technical terms.
  "file", "files", "code", "line", "lines", "variable", "value", "name",
  "issue", "bug", "problem", "question", "answer", "example", "case",
  "part", "section", "here", "there", "now", "then",
  // Git / version control (noise as search terms)
  "commit", "commits", "committed", "committing",
  "push", "pushes", "pushed", "pushing",
  "pull", "pulls", "pulled", "pulling",
  "branch", "branches", "branched", "branching",
  "rebase", "rebases", "rebased", "rebasing",
  "stash", "stashes", "stashed", "stashing",
  "cherry-pick",
  "tag", "tags", "tagged", "tagging",
]);

// --- Signal detection patterns ---

// NOTE: These regex patterns are intentionally simple — we're classifying prompts,
// not parsing natural language. False negatives are acceptable; false positives are not.

const ACTION_VERBS_RE = /^(fix|add|update|change|remove|delete|create|move|rename|refactor|implement|replace|rewrite|merge|split|extract|convert|modify|debug|test|check|verify|clean|optimize|improve|handle|set|build|install|enable|disable|ensure)\b/i;

const TECHNICAL_QUESTION_RE = /^(where|what|how|which|find|show|list)\b/i;

const DEFINITION_QUERY_RE = /\b(where\s+is|what\s+file|what\s+imports|what\s+exports|dependents?\s+of|dependencies?\s+of|who\s+calls|who\s+uses|defined\s+in|declaration\s+of|definition\s+of|imported\s+by|exported\s+by|called\s+from)\b/i;

const IMPORT_REQUIRE_RE = /\b(import|require|from)\s+['"`]|import\s*\(|require\s*\(/;

const ERROR_TRACE_RE = /\b(Error|TypeError|ReferenceError|SyntaxError|at\s+\w+\s*\(|Traceback|raise\s+\w+|panic:|ENOENT|EACCES|EPERM|errno|stack\s*trace)\b/;

const GIT_COMMAND_RE = /^\s*(git\s+|commit\s|push\s|pull\s|rebase\s|merge\s|stash\s|cherry-pick|tag\s|revert\s|checkout\s|clone\s|fetch\s|diff\s|log\s|status\s|reset\s|deploy\s|publish\s|release\s)/i;

const META_CONVERSATIONAL_RE = /^(thank|thanks|hello|hi|hey|good\s+(morning|afternoon|evening)|sounds?\s+good|great|perfect|awesome|nice|cool|got\s+it|understood|i\s+see|makes?\s+sense|nevermind|never\s+mind|forget\s+it|scratch\s+that|wait|hold\s+on|one\s+moment|sorry|oops|my\s+bad|no\s+worries|np|nvm)\b/i;

const CODE_FENCE_RE = /^```/;

// Pure affirmative/negative phrases — exact match (lowercased, trimmed)
const AFFIRMATIVE_PHRASES = new Set([
  "yes", "no", "ok", "okay", "sure", "yep", "yup", "nope", "nah",
  "go ahead", "do it", "go for it", "proceed", "continue",
  "thanks", "thank you", "ty", "thx",
  "lgtm", "looks good", "looks good to me", "looks great",
  "perfect", "great", "awesome", "nice", "cool",
  "got it", "understood", "i see", "makes sense",
  "done", "finished", "complete", "completed",
  "approved", "ship it",
  "yes please", "no thanks", "yes do it", "please do",
  "sounds good", "sounds great", "sounds right",
  "right", "correct", "exactly", "indeed",
]);

// --- Core classifier ---

function shouldRetrieve(prompt) {
  // Phase 1: Early exits — definitely skip retrieval
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return { retrieve: false, terms: [], confidence: 1.0 };
  }

  const trimmed = prompt.trim();

  // Slash commands or shell escapes
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) {
    return { retrieve: false, terms: [], confidence: 1.0 };
  }

  // Pure affirmative/negative exact matches
  const normalized = trimmed.toLowerCase().replace(/[.!?,]+$/, "").trim();
  if (AFFIRMATIVE_PHRASES.has(normalized)) {
    return { retrieve: false, terms: [], confidence: 1.0 };
  }

  // Tokenize for analysis
  const rawTokens = trimmed.split(/\s+/);
  const wordCount = rawTokens.length;

  // Scan ALL tokens for identifier shapes and paths BEFORE early exit on single words.
  // WHY: We need these for both the single-word early exit check and signal scoring.
  const identifiers = [];
  const paths = [];
  for (const tok of rawTokens) {
    // Strip leading/trailing punctuation for shape analysis
    const cleaned = tok.replace(/^[^a-zA-Z0-9_/.]+/, "").replace(/[^a-zA-Z0-9_/.]+$/, "");
    if (!cleaned) continue;
    // WHY: Strip :line:col suffixes (e.g., "resolver.js:42:8") before path detection.
    // Without this, ext becomes ".js:42" which doesn't match PATH_EXTENSIONS.
    const pathCandidate = cleaned.replace(/:\d+(?::\d+)?$/, "");
    if (looksLikePath(pathCandidate)) paths.push(pathCandidate);
    else if (hasIdentifierShape(cleaned)) identifiers.push(cleaned);
  }

  // Single word with no identifier shape and not a file path → skip
  if (wordCount === 1 && identifiers.length === 0 && paths.length === 0) {
    return { retrieve: false, terms: [], confidence: 0.9 };
  }

  // Phase 2 & 3: Score-based classification
  let score = 0;

  // --- Positive signals ---

  // Identifier shape: camelCase, PascalCase, snake_case, CONST_CASE
  if (identifiers.length > 0) score += 3;

  // File path or extension
  if (paths.length > 0) score += 4;

  // Technical question pattern: starts with where/what/how/which/find/show/list.
  // WHY: The lone question word isn't enough evidence — "how are you today" and
  // "what is the weather" both match but are conversational.  Require either
  // an identifier/path in the prompt (concrete code target) OR a definition-
  // query form ("where is X defined", "what imports X") or import/require
  // reference elsewhere in the prompt.  Concept queries like "how does
  // retrieval work" still succeed via the deferred moderate-length bonus
  // (+1) + the term itself surviving SKIP_TERMS; they won't get the full +3
  // but they'll clear the score>=1 borderline threshold.
  if (
    TECHNICAL_QUESTION_RE.test(trimmed) &&
    wordCount >= 3 &&
    (identifiers.length > 0 ||
      paths.length > 0 ||
      DEFINITION_QUERY_RE.test(trimmed) ||
      IMPORT_REQUIRE_RE.test(trimmed))
  ) {
    score += 3;
  }

  // Action verb + code target: starts with action verb AND has identifier or path in rest
  if (ACTION_VERBS_RE.test(trimmed) && (identifiers.length > 0 || paths.length > 0)) score += 3;

  // Error trace markers
  if (ERROR_TRACE_RE.test(trimmed)) score += 2;

  // Import/require reference
  if (IMPORT_REQUIRE_RE.test(trimmed)) score += 3;

  // Definition query language
  if (DEFINITION_QUERY_RE.test(trimmed)) score += 3;

  // Moderate length with at least one surviving term
  // NOTE: Checked after extraction below — deferred

  // --- Negative signals ---

  // Very short (<4 words) and no identifiers
  if (wordCount < 4 && identifiers.length === 0 && paths.length === 0) score -= 3;

  // Git/commit command without code reference (identifier or path)
  if (GIT_COMMAND_RE.test(trimmed) && identifiers.length === 0 && paths.length === 0) score -= 4;

  // Pure meta/conversational without code ref
  if (META_CONVERSATIONAL_RE.test(trimmed) && identifiers.length === 0 && paths.length === 0) score -= 3;

  // Extremely long (>200 words) without file paths
  if (wordCount > 200 && paths.length === 0) score -= 2;

  // Starts with code fence without identifiers
  if (CODE_FENCE_RE.test(trimmed) && identifiers.length === 0 && paths.length === 0) score -= 2;

  // --- Term extraction ---
  const terms = extractTerms(trimmed);

  // Deferred positive signal: moderate length 4-80 words with at least one surviving term
  if (wordCount >= 4 && wordCount <= 80 && terms.length > 0) score += 1;

  // If zero terms survive, skip retrieval regardless of score
  if (terms.length === 0) {
    return { retrieve: false, terms: [], confidence: 0.7 };
  }

  // --- Decision ---
  if (score >= 3) {
    // WHY: Confidence scales with score — higher-signal prompts get more confidence,
    // which downstream can use to decide how many results to inject.
    const confidence = Math.min(1.0, 0.5 + (score - 3) * 0.1);
    return { retrieve: true, terms, confidence };
  }

  if (score >= 1) {
    // Borderline — might be worth retrieving with fewer results
    return { retrieve: true, terms, confidence: 0.4 };
  }

  // Score <= 0 — skip
  return { retrieve: false, terms, confidence: Math.max(0.1, 0.3 + score * 0.05) };
}

// --- Term extraction ---

function extractTerms(prompt) {
  if (!prompt || typeof prompt !== "string") return [];

  const rawTokens = prompt.trim().split(/\s+/);
  const terms = [];

  for (const tok of rawTokens) {
    // Strip punctuation from edges, but preserve internal dots/slashes for paths
    const cleaned = tok.replace(/^[^a-zA-Z0-9_/.]+/, "").replace(/[^a-zA-Z0-9_/.]+$/, "");
    if (!cleaned || cleaned.length < 2) continue;

    // WHY: Strip :line:col suffixes before path detection (same as signal scan)
    const pathCandidate = cleaned.replace(/:\d+(?::\d+)?$/, "");
    // Keep file paths whole (contains / or ends in known extension)
    if (looksLikePath(pathCandidate)) {
      terms.push(pathCandidate);
      continue;
    }

    // Keep identifiers (camelCase, snake_case, etc.)
    if (hasIdentifierShape(cleaned)) {
      terms.push(cleaned);
      continue;
    }

    // Drop tokens in SKIP_TERMS
    if (SKIP_TERMS.has(cleaned.toLowerCase())) continue;

    // Drop very short tokens (< 2 chars already handled above)
    // Keep the rest — they might be meaningful technical terms
    terms.push(cleaned);
  }

  // Cap at 6 terms
  // WHY: More terms dilute search precision. 6 is enough for multi-word queries
  // while keeping the search focused.
  return terms.slice(0, 6);
}

module.exports = {
  shouldRetrieve,
  // WHY: Exported for testability — these are implementation details but
  // the test plan specifically requires validating them independently.
  hasIdentifierShape,
  looksLikePath,
  extractTerms,
};
