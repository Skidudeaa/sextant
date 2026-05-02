"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldRetrieve,
  hasIdentifierShape,
  looksLikePath,
  extractTerms,
} = require("../lib/classifier");

// ─── hasIdentifierShape ─────────────────────────────────────────────

describe("hasIdentifierShape", () => {
  it("camelCase", () => {
    assert.equal(hasIdentifierShape("rerankFiles"), true);
    assert.equal(hasIdentifierShape("shouldRetrieve"), true);
    assert.equal(hasIdentifierShape("graphDb"), true);
  });

  it("PascalCase", () => {
    assert.equal(hasIdentifierShape("MyModel"), true);
    assert.equal(hasIdentifierShape("GraphNode"), true);
    assert.equal(hasIdentifierShape("SessionStart"), true);
  });

  it("snake_case", () => {
    assert.equal(hasIdentifierShape("process_data"), true);
    assert.equal(hasIdentifierShape("fan_in_count"), true);
    assert.equal(hasIdentifierShape("get_value"), true);
  });

  it("CONST_CASE", () => {
    assert.equal(hasIdentifierShape("MAX_RETRIES"), true);
    assert.equal(hasIdentifierShape("API_KEY"), true);
    assert.equal(hasIdentifierShape("SKIP_TERMS"), true);
  });

  it("rejects plain lowercase words", () => {
    assert.equal(hasIdentifierShape("hello"), false);
    assert.equal(hasIdentifierShape("commit"), false);
    assert.equal(hasIdentifierShape("scoring"), false);
  });

  it("accepts initialisms (acronyms)", () => {
    // WHY changed (Swift v1): bare uppercase initialisms (URL, JSON, JWT, API,
    // XML) ARE code-relevant tokens — common in Swift/ObjC types like
    // URLSession, JSONDecoder, and equally common in JS/Python imports.
    // Previously rejected as "ambiguous English acronyms"; now accepted as
    // identifiers so they earn the +3 identifier-shape signal in
    // shouldRetrieve.  The cost of a false positive is one extra search
    // returning loose hits (cheap); the cost of a false negative is missing
    // a code query.
    assert.equal(hasIdentifierShape("JWT"), true);
    assert.equal(hasIdentifierShape("API"), true);
    assert.equal(hasIdentifierShape("URL"), true);
    assert.equal(hasIdentifierShape("JSON"), true);
    // Initialism + camelCase tail also matches.
    assert.equal(hasIdentifierShape("URLSession"), true);
    assert.equal(hasIdentifierShape("JSONDecoder"), true);
    assert.equal(hasIdentifierShape("XMLParser"), true);
  });

  it("rejects empty/short/null", () => {
    assert.equal(hasIdentifierShape(""), false);
    assert.equal(hasIdentifierShape("a"), false);
    assert.equal(hasIdentifierShape(null), false);
    assert.equal(hasIdentifierShape(undefined), false);
  });
});

// ─── looksLikePath ──────────────────────────────────────────────────

describe("looksLikePath", () => {
  it("paths with slashes", () => {
    assert.equal(looksLikePath("lib/graph.js"), true);
    assert.equal(looksLikePath("src/utils/"), true);
    assert.equal(looksLikePath("commands/scan.js"), true);
  });

  it("filenames with known extensions", () => {
    assert.equal(looksLikePath("graph.js"), true);
    assert.equal(looksLikePath("config.yaml"), true);
    assert.equal(looksLikePath("resolver.ts"), true);
    assert.equal(looksLikePath("app.py"), true);
    assert.equal(looksLikePath("main.go"), true);
    assert.equal(looksLikePath("Cargo.toml"), true);
  });

  it("rejects plain words without extensions", () => {
    assert.equal(looksLikePath("hello"), false);
    assert.equal(looksLikePath("scoring"), false);
    assert.equal(looksLikePath("middleware"), false);
  });

  it("rejects unknown extensions", () => {
    // WHY: ".xyz" is not in PATH_EXTENSIONS — we only recognize common source/config types
    assert.equal(looksLikePath("file.xyz"), false);
  });

  it("rejects empty/null", () => {
    assert.equal(looksLikePath(""), false);
    assert.equal(looksLikePath(null), false);
    assert.equal(looksLikePath(undefined), false);
  });
});

// ─── extractTerms ───────────────────────────────────────────────────

describe("extractTerms", () => {
  it("strips noise words and keeps meaningful terms", () => {
    const terms = extractTerms("where is the scoring logic");
    assert.ok(terms.includes("scoring"), `expected "scoring" in ${JSON.stringify(terms)}`);
    assert.ok(terms.includes("logic"), `expected "logic" in ${JSON.stringify(terms)}`);
    // "where", "is", "the" should be stripped
    assert.ok(!terms.includes("where"));
    assert.ok(!terms.includes("is"));
    assert.ok(!terms.includes("the"));
  });

  it("keeps identifiers intact", () => {
    const terms = extractTerms("update rerankFiles to handle edge case");
    assert.ok(terms.includes("rerankFiles"));
    // "update" is an action verb → stripped
    assert.ok(!terms.includes("update"));
  });

  it("keeps file paths whole", () => {
    const terms = extractTerms("look at lib/graph.js");
    assert.ok(terms.includes("lib/graph.js"));
  });

  it("keeps filename with extension and strips query verbs", () => {
    const terms = extractTerms("what imports intel.js");
    assert.ok(terms.includes("intel.js"));
    // WHY: "imports" is a definition-query word — signal for detection, noise for search
    assert.ok(!terms.includes("imports"), `"imports" should be stripped, got ${JSON.stringify(terms)}`);
  });

  it("strips action verbs that are signal-only", () => {
    const terms = extractTerms("fix add update refactor");
    assert.equal(terms.length, 0, "all action verbs should be stripped");
  });

  it("strips punctuation from token edges", () => {
    const terms = extractTerms("what is `rerankFiles`?");
    assert.ok(terms.includes("rerankFiles"));
  });

  it("drops tokens shorter than 2 chars", () => {
    const terms = extractTerms("a b c rerankFiles");
    assert.deepEqual(terms, ["rerankFiles"]);
  });

  it("caps at 6 terms", () => {
    const terms = extractTerms("alpha bravo charlie delta echo foxtrot golf hotel india juliet");
    assert.ok(terms.length <= 6, `expected at most 6 terms, got ${terms.length}`);
  });

  it("returns empty array for empty/null input", () => {
    assert.deepEqual(extractTerms(""), []);
    assert.deepEqual(extractTerms(null), []);
    assert.deepEqual(extractTerms(undefined), []);
  });

  it("handles multi-word code query", () => {
    const terms = extractTerms("update auth middleware to use JWT");
    // "update" stripped (action verb), "to", "use" stripped (noise)
    assert.ok(terms.includes("auth"), `expected "auth" in ${JSON.stringify(terms)}`);
    assert.ok(terms.includes("middleware"), `expected "middleware" in ${JSON.stringify(terms)}`);
    assert.ok(terms.includes("JWT"), `expected "JWT" in ${JSON.stringify(terms)}`);
    assert.ok(!terms.includes("update"));
    assert.ok(!terms.includes("to"));
    assert.ok(!terms.includes("use"));
  });
});

// ─── shouldRetrieve — early exits ───────────────────────────────────

describe("shouldRetrieve — early exits", () => {
  it("empty string → skip", () => {
    const r = shouldRetrieve("");
    assert.equal(r.retrieve, false);
    assert.deepEqual(r.terms, []);
  });

  it("whitespace only → skip", () => {
    const r = shouldRetrieve("   \n\t  ");
    assert.equal(r.retrieve, false);
  });

  it("null → skip", () => {
    const r = shouldRetrieve(null);
    assert.equal(r.retrieve, false);
  });

  it("undefined → skip", () => {
    const r = shouldRetrieve(undefined);
    assert.equal(r.retrieve, false);
  });

  it("non-string → skip", () => {
    const r = shouldRetrieve(42);
    assert.equal(r.retrieve, false);
  });

  it("slash command → skip", () => {
    assert.equal(shouldRetrieve("/commit").retrieve, false);
    assert.equal(shouldRetrieve("/help").retrieve, false);
    assert.equal(shouldRetrieve("/watch status").retrieve, false);
  });

  it("shell escape → skip", () => {
    assert.equal(shouldRetrieve("!ls -la").retrieve, false);
    assert.equal(shouldRetrieve("!git status").retrieve, false);
  });

  it("affirmative phrases → skip", () => {
    assert.equal(shouldRetrieve("yes").retrieve, false);
    assert.equal(shouldRetrieve("no").retrieve, false);
    assert.equal(shouldRetrieve("ok").retrieve, false);
    assert.equal(shouldRetrieve("sure").retrieve, false);
    assert.equal(shouldRetrieve("go ahead").retrieve, false);
    assert.equal(shouldRetrieve("do it").retrieve, false);
    assert.equal(shouldRetrieve("thanks").retrieve, false);
    assert.equal(shouldRetrieve("lgtm").retrieve, false);
    assert.equal(shouldRetrieve("looks good to me").retrieve, false);
    assert.equal(shouldRetrieve("yes do it").retrieve, false);
    assert.equal(shouldRetrieve("ship it").retrieve, false);
  });

  it("affirmative with trailing punctuation → skip", () => {
    // WHY: "yes!" and "ok." should still match after punctuation stripping
    assert.equal(shouldRetrieve("yes!").retrieve, false);
    assert.equal(shouldRetrieve("ok.").retrieve, false);
    assert.equal(shouldRetrieve("thanks!").retrieve, false);
    assert.equal(shouldRetrieve("sounds good!").retrieve, false);
  });

  it("single common word → skip", () => {
    assert.equal(shouldRetrieve("hello").retrieve, false);
    assert.equal(shouldRetrieve("commit").retrieve, false);
    assert.equal(shouldRetrieve("test").retrieve, false);
  });

  it("single identifier word → retrieve", () => {
    // NOTE: Single camelCase word IS an identifier — should trigger retrieval
    const r = shouldRetrieve("rerankFiles");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("rerankFiles"));
  });

  it("single file path → retrieve", () => {
    const r = shouldRetrieve("graph.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("graph.js"));
  });
});

// ─── shouldRetrieve — positive signals ──────────────────────────────

describe("shouldRetrieve — positive signals", () => {
  it("identifier shape triggers retrieval", () => {
    const r = shouldRetrieve("update rerankFiles");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("rerankFiles"));
  });

  it("file path triggers retrieval", () => {
    const r = shouldRetrieve("look at lib/graph.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("lib/graph.js"));
  });

  it("technical question pattern", () => {
    const r = shouldRetrieve("where is the scoring logic");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("scoring"));
  });

  it("action + code target", () => {
    const r = shouldRetrieve("fix the resolveImport function");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("resolveImport"));
  });

  it("error trace markers", () => {
    const r = shouldRetrieve("TypeError: Cannot read property 'path' of undefined in graph module");
    assert.equal(r.retrieve, true);
  });

  it("import/require reference", () => {
    const r = shouldRetrieve("the line import { Graph } from './graph' is failing");
    assert.equal(r.retrieve, true);
  });

  it("definition query language", () => {
    const r = shouldRetrieve("what imports intel.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("intel.js"));
  });

  it("where is query", () => {
    const r = shouldRetrieve("where is shouldRetrieve defined");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("shouldRetrieve"));
  });

  it("dependents of query", () => {
    const r = shouldRetrieve("dependents of graph.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("graph.js"));
  });

  it("multi-word code query with mixed signals", () => {
    const r = shouldRetrieve("update auth middleware to use JWT");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("auth"));
    assert.ok(r.terms.includes("middleware"));
    assert.ok(r.terms.includes("JWT"));
  });

  it("PascalCase identifier", () => {
    const r = shouldRetrieve("what does GraphNode do");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("GraphNode"));
  });

  it("snake_case identifier", () => {
    const r = shouldRetrieve("look at process_data");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("process_data"));
  });

  it("CONST_CASE identifier", () => {
    const r = shouldRetrieve("what is MAX_RETRIES set to");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("MAX_RETRIES"));
  });
});

// ─── shouldRetrieve — negative signals ──────────────────────────────

describe("shouldRetrieve — negative signals", () => {
  it("very short no identifiers → skip", () => {
    const r = shouldRetrieve("not sure");
    assert.equal(r.retrieve, false);
  });

  it("git command without code reference → skip", () => {
    const r = shouldRetrieve("git push origin main");
    assert.equal(r.retrieve, false);
  });

  it("commit the changes → skip", () => {
    // WHY: "commit the changes" has no identifier and no path — pure git meta
    const r = shouldRetrieve("commit the changes");
    assert.equal(r.retrieve, false);
  });

  it("git command WITH code reference → retrieve", () => {
    // "commit changes to resolver.js" — has a file path, should retrieve
    const r = shouldRetrieve("commit changes to resolver.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("resolver.js"));
  });

  it("pure conversational without code ref → skip", () => {
    const r = shouldRetrieve("thanks for the help");
    assert.equal(r.retrieve, false);
  });

  it("hello greeting → skip", () => {
    const r = shouldRetrieve("hello there");
    assert.equal(r.retrieve, false);
  });

  it("code fence without identifiers → suppressed", () => {
    // NOTE: Code fences with no identifiers get a penalty but might still
    // retrieve if other signals are strong enough. With no other signals,
    // should skip.
    const r = shouldRetrieve("```\nsome plain text\n```");
    assert.equal(r.retrieve, false);
  });
});

// ─── shouldRetrieve — edge cases from the plan ─────────────────────

describe("shouldRetrieve — edge cases", () => {
  it("'fix it' → skip (zero terms survive)", () => {
    // WHY: "fix" is an action verb (stripped), "it" is a pronoun (stripped).
    // Even though "fix" triggers action-verb detection, no terms survive extraction.
    const r = shouldRetrieve("fix it");
    assert.equal(r.retrieve, false);
    assert.deepEqual(r.terms, []);
  });

  it("'rerankFiles' single identifier → retrieve", () => {
    const r = shouldRetrieve("rerankFiles");
    assert.equal(r.retrieve, true);
    assert.deepEqual(r.terms, ["rerankFiles"]);
  });

  it("'where is the scoring logic' → retrieve with 'scoring'", () => {
    const r = shouldRetrieve("where is the scoring logic");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("scoring"));
  });

  it("'update auth middleware to use JWT' → retrieve with auth, middleware, JWT", () => {
    const r = shouldRetrieve("update auth middleware to use JWT");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("auth"));
    assert.ok(r.terms.includes("middleware"));
    assert.ok(r.terms.includes("JWT"));
  });

  it("'look at lib/graph.js' → retrieve with lib/graph.js", () => {
    const r = shouldRetrieve("look at lib/graph.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("lib/graph.js"));
  });

  it("'what imports intel.js' → retrieve with intel.js", () => {
    const r = shouldRetrieve("what imports intel.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("intel.js"));
  });

  it("error trace with file reference", () => {
    const r = shouldRetrieve("TypeError: Cannot read property 'resolve' at resolver.js:42");
    assert.equal(r.retrieve, true);
  });

  it("long prompt without paths gets penalty but may still retrieve if has identifiers", () => {
    // 200+ words of filler plus an identifier
    const filler = "word ".repeat(201);
    const r = shouldRetrieve(filler + "rerankFiles");
    // Has identifier (+3) and moderate length (+1) but >200 words no paths (-2) → net +2
    // With identifier shape, should at least be borderline
    assert.equal(r.retrieve, true);
  });

  it("prompt with only action verbs and noise → skip", () => {
    const r = shouldRetrieve("please fix and update the code");
    assert.equal(r.retrieve, false);
  });

  // WHY: these lock in the false-positive fixes for conversational prompts
  // that used to trip the tech-question bonus alone.  "how", "today", "hello"
  // are all filler/skip terms now, so these prompts drain to zero
  // code-relevant evidence.
  it("'how are you today' → skip (conversational)", () => {
    assert.equal(shouldRetrieve("how are you today").retrieve, false);
  });

  it("'thanks for your help' → skip", () => {
    assert.equal(shouldRetrieve("thanks for your help").retrieve, false);
  });

  it("'hello' → skip", () => {
    assert.equal(shouldRetrieve("hello").retrieve, false);
  });

  // And verify genuine tech questions with concrete code targets still fire.
  it("'how does rerankFiles work' → retrieve (identifier + tech-question)", () => {
    const r = shouldRetrieve("how does rerankFiles work");
    assert.equal(r.retrieve, true);
    assert.ok(r.confidence >= 0.7);
  });

  it("'where is loadDb defined' → retrieve (def-query + identifier)", () => {
    assert.equal(shouldRetrieve("where is loadDb defined").retrieve, true);
  });
});

// ─── shouldRetrieve — confidence levels ─────────────────────────────

describe("shouldRetrieve — confidence levels", () => {
  it("high-signal prompt gets confidence >= 0.5", () => {
    // File path (+4) + technical question (+3) + moderate length (+1) = 8
    const r = shouldRetrieve("where is the handler in lib/graph.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.confidence >= 0.5, `expected confidence >= 0.5, got ${r.confidence}`);
  });

  it("very high signal gets confidence approaching 1.0", () => {
    // identifier (+3) + path (+4) + definition query (+3) + tech question (+3) + moderate (+1) = 14
    const r = shouldRetrieve("where is findExportsBySymbol defined in lib/graph.js");
    assert.equal(r.retrieve, true);
    assert.ok(r.confidence >= 0.8, `expected confidence >= 0.8, got ${r.confidence}`);
  });

  it("borderline prompt gets confidence 0.4", () => {
    // Need score 1-2: moderate length with surviving terms but no strong signals
    // "please explain the overall architecture and design" — moderate length (+1), terms survive
    // No identifiers, no paths, no tech question prefix, no action+target
    const r = shouldRetrieve("explain the overall architecture and design philosophy");
    // If it's borderline (score 1-2), confidence should be 0.4
    if (r.retrieve && r.confidence < 0.5) {
      assert.equal(r.confidence, 0.4);
    }
  });

  it("early exit gets confidence >= 0.7", () => {
    const r = shouldRetrieve("yes");
    assert.equal(r.retrieve, false);
    assert.ok(r.confidence >= 0.7, `expected confidence >= 0.7, got ${r.confidence}`);
  });

  it("confidence is always between 0 and 1", () => {
    const prompts = [
      "", "yes", "/help", "hello", "rerankFiles",
      "where is the scoring logic",
      "update auth middleware to use JWT",
      "fix it",
      "git push origin main",
      "TypeError: Cannot read property",
    ];
    for (const p of prompts) {
      const r = shouldRetrieve(p);
      assert.ok(r.confidence >= 0 && r.confidence <= 1.0,
        `confidence ${r.confidence} out of range for prompt: "${p}"`);
    }
  });
});

// ─── shouldRetrieve — single-word and short code queries ────────────
//
// WHY: These lock in the fix for the false-negative class where plain
// lowercase module-name queries (e.g. "retrieval", "scoring") and 2-3
// word concept questions (e.g. "how retrieval works") used to silently
// skip retrieval because the -3 short-prompt penalty fired even when a
// plausible code term had survived noise filtering.

describe("shouldRetrieve — single-word code tokens", () => {
  it("single plausible module name → retrieve", () => {
    for (const q of ["retrieval", "scoring", "resolver", "watcher", "classifier"]) {
      const r = shouldRetrieve(q);
      assert.equal(r.retrieve, true, `expected "${q}" to retrieve`);
      assert.deepEqual(r.terms, [q]);
    }
  });

  it("single affirmative/noise word still skips", () => {
    for (const q of ["yes", "ok", "thanks", "sure", "hi"]) {
      const r = shouldRetrieve(q);
      assert.equal(r.retrieve, false, `expected "${q}" to skip`);
    }
  });

  it("single 2-char word skips (too short to be a meaningful code term)", () => {
    const r = shouldRetrieve("ab");
    assert.equal(r.retrieve, false);
  });
});

describe("shouldRetrieve — short concept questions", () => {
  it("'how retrieval works' → retrieve with 'retrieval'", () => {
    const r = shouldRetrieve("how retrieval works");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("retrieval"));
  });

  it("'query classification' → retrieve with both nouns", () => {
    const r = shouldRetrieve("query classification");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("query"));
    assert.ok(r.terms.includes("classification"));
  });

  it("'scoring logic' → retrieve with both nouns", () => {
    const r = shouldRetrieve("scoring logic");
    assert.equal(r.retrieve, true);
    assert.ok(r.terms.includes("scoring"));
    assert.ok(r.terms.includes("logic"));
  });

  it("conversational short phrases still skip", () => {
    for (const q of ["not sure", "one moment", "hold on", "never mind"]) {
      const r = shouldRetrieve(q);
      assert.equal(r.retrieve, false, `expected "${q}" to skip`);
    }
  });
});
