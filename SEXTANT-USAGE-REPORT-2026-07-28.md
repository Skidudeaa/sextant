# Sextant — usage report from a long session

**Context:** ~438 tool calls, one working day, somaNotes. 11 commits. Work was
overwhelmingly *verification*: does this line exist, what does this function
return, did this test ever pass.

**Confirmed setup:** `sextant hook sessionstart / refresh / posttooluse /
subagentstart` in `.claude/settings.json`, plus 9 MCP tools. Both the injected
`<codebase-intelligence>` blocks and the tool surface are sextant.

---

## The headline

**I never called a single sextant MCP tool.** Not once in ~438 tool calls.
`sextant_search`, `sextant_orient`, `sextant_explain`, `sextant_related`,
`sextant_closure`, `sextant_focus`, `sextant_scope` were all available; I reached
for `grep` and `Read` every time.

Not a knock on quality — a signal about fit. Verification work wants exact matches
with `file:line` I can quote in a commit message. Semantic search is the wrong
instrument for "prove this claim," and after being wrong three times by inferring,
I was deliberately biased toward the most literal tool available.

---

## What earned its place

**The `[orient]` hook — best thing in the plugin.** Touching Transfer Center and
RAG, it fired: *"read the current-state doc FIRST, don't re-trace."* That's the
difference between reading `TRANSFER_CENTER_CURRENT.md` and re-deriving the
architecture. Landed at exactly the right moment, twice.

**Staleness honesty.** `⚠ index stale: repo changed since last scan` appeared
repeatedly while a parallel session committed. A tool that says "don't trust me
right now" is doing something most don't.

**"Recent changes (git)."** The one block section that changed meaningfully turn
to turn — though in practice I caught peer edits from the hook state footer's
`dirty=` list first, every time.

---

## What cost more than it returned

**The static payload.** Commands, required env, structure, dependency hotspots,
public API — ~30 of ~40 injected lines were byte-identical every turn for ~40
turns. I used **none** of them. `core/settings.py: 178 fan-in` is genuinely
interesting and I never once acted on it, because it arrived as ambient wallpaper
rather than at a decision point.

**Retrieval fires on conversational words.** It matches the *word*, not the
*intent* — same class of mistake as a source-text test matching a comment:

| I said | It returned |
|---|---|
| "handoff" | `audit-handoff.py`, `tests/test_am_handoff.py`, `services/progress_note_schema.py` |
| "take ownership pls" | `hyperdrive/router.py` *(export name contains: ownership)*, `test_note_evolution_ownership_guard.py` |
| "static payload" *(discussing sextant's design)* | `services/versioned_static.py`, `api/middleware/static_handler.py`, two `*payload*` tests |

The third fired while I was critiquing this exact behaviour. In all three I was
writing prose, not looking for code.

---

## Changes I'd make

1. **Static sections once per session, not per turn** — or behind a tool call.
   I'll fetch hotspots when I'm about to edit something.
2. **Surface fan-in at edit time.** "You're editing `core/settings.py` — 178 files
   import this" is valuable *as I open the file*. As a standing list it's invisible.
3. **Suppress retrieval when the message has no code-shaped intent.** "push",
   "handoff", "thanks" shouldn't trigger a file search.
4. **Keep orient exactly as it is.**

---

## On "so agents don't have to think"

Exactly right for **navigation**, exactly wrong for **verification**.

- *Which doc is authoritative? Where does this subsystem live? Is my index stale?*
  — pure overhead, no judgment involved. Push it hard. That's orient.
- *What does this function return? Does this field exist? Did this test ever pass?*
  — pushing a cached answer is actively dangerous, because a summarized fact is
  precisely what I'll cite without re-checking.

Today's three worst moments were all the second kind. None involved sextant, but
they're the pattern:

- CLAUDE.md said *"22 failures, all one dead mock target — a cheap standalone
  cleanup."* I nearly acted on it. Wrong twice over; those tests had never passed
  in seven months.
- A plan said *"zero production call sites."* There were two, and the live
  endpoint reached one.
- I said labs were missing because of a prompt rule. Twice, in opposite
  directions, without tracing a single value.

Every one was a **cached description of code state** trusted instead of checked.
That's the exact artifact a context plugin is in the business of producing — which
is why I'd hold the line hard at navigation.

**The dangerous zone isn't stale data, it's *plausible* stale data.**
`⚠ index stale` is safe because it announces itself. `fan-in: 178` is safe because
it's structural and cheap to re-derive. What would be genuinely risky is sextant
telling me *what a function does* — I'd repeat it in a commit message and you'd
have no way to know I never opened the file.

**Eliminate the walk to the file. Never eliminate the read.**

---

## Caveat

I can't measure what it *prevented*. If ambient context quietly steered me toward
the right files, I'd experience that as simply knowing where to look. Treat "I
never called the tools" as solid and "the static block wasn't useful" as
subjective. The real test: a session with the block cut to orient +
recent-changes + staleness, and see whether anything degrades.
