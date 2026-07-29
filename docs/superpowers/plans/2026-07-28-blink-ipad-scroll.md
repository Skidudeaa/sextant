# Blink iPad Direct Scrolling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Blink two-finger touchscreen and trackpad gestures scroll conversation output directly in Codex CLI and Claude Code across current and future tmux sessions.

**Architecture:** tmux becomes the persistent mouse-event boundary with a large server-side history. Claude Code retains its fullscreen virtual scrollback and receives forwarded mouse events, while Codex uses inline raw output so tmux owns its scrollback.

**Tech Stack:** tmux configuration, Codex CLI TOML configuration, Claude Code JSON configuration, `jq`, Python `tomllib`

## Global Constraints

- Preserve every unrelated setting in `/root/.codex/config.toml` and `/root/.claude/settings.json`.
- Keep Claude Code configured with `"tui": "fullscreen"`.
- Configure Codex with `alternate_screen = "never"` and `raw_output_mode = true`.
- Configure tmux with `mouse on` and `history-limit 100000`.
- Apply tmux settings to the currently running server and persist them for future servers.
- Do not claim the iPad gesture itself is proven until the user performs the physical Blink test.

---

### Task 1: Persist and activate direct scrolling

**Files:**
- Create: `/root/.tmux.conf`
- Modify: `/root/.codex/config.toml`
- Verify unchanged: `/root/.claude/settings.json`

**Interfaces:**
- Consumes: Blink wheel-like mouse events, the active tmux server, Codex CLI 0.145.0, and Claude Code 2.1.220.
- Produces: tmux global options `mouse=on` and `history-limit=100000`; Codex TUI settings `alternate_screen=never` and `raw_output_mode=true`; preserved Claude fullscreen mode.

- [ ] **Step 1: Prove the current configuration does not satisfy the target**

Run:

```bash
test "$(tmux show-option -gv mouse)" = "on"
test "$(tmux show-option -gv history-limit)" = "100000"
python -c 'import tomllib; d=tomllib.load(open("/root/.codex/config.toml","rb")); assert d["tui"].get("alternate_screen") == "never"; assert d["tui"].get("raw_output_mode") is True'
```

Expected: at least the first command fails because the active tmux server
currently reports `mouse=off`; the Codex assertion also fails because neither
setting exists yet.

- [ ] **Step 2: Back up the Codex configuration**

Run:

```bash
test ! -e /root/.codex/config.toml.bak-20260728-blink-scroll
cp /root/.codex/config.toml /root/.codex/config.toml.bak-20260728-blink-scroll
```

Expected: the backup exists and is byte-for-byte identical to the original:

```bash
cmp /root/.codex/config.toml /root/.codex/config.toml.bak-20260728-blink-scroll
```

- [ ] **Step 3: Create the persistent tmux configuration**

Use `apply_patch` to create `/root/.tmux.conf` with exactly:

```tmux
set -g mouse on
set -g history-limit 100000
```

- [ ] **Step 4: Add the Codex TUI settings**

Use `apply_patch` to add these two keys directly under the existing `[tui]`
table in `/root/.codex/config.toml`, leaving all existing keys and tables
unchanged:

```toml
alternate_screen = "never"
raw_output_mode = true
```

- [ ] **Step 5: Parse the persistent files before applying runtime state**

Run:

```bash
python -c 'import tomllib; d=tomllib.load(open("/root/.codex/config.toml","rb")); assert d["tui"]["alternate_screen"] == "never"; assert d["tui"]["raw_output_mode"] is True'
jq -e '.tui == "fullscreen"' /root/.claude/settings.json
tmux -L blink-scroll-verify -f /root/.tmux.conf new-session -d -s verify
tmux -L blink-scroll-verify show-option -gv mouse
tmux -L blink-scroll-verify show-option -gv history-limit
tmux -L blink-scroll-verify kill-server
```

Expected:

```text
true
on
100000
```

The temporary `blink-scroll-verify` server is intentionally stopped after
syntax and option validation. The user's active tmux server is not affected by
this isolated check.

- [ ] **Step 6: Apply the tmux settings to the active server**

Run:

```bash
tmux source-file /root/.tmux.conf
```

Expected: exit status `0` with no output.

- [ ] **Step 7: Verify persistent and live state**

Run:

```bash
tmux show-option -gv mouse
tmux show-option -gv history-limit
python -c 'import tomllib; d=tomllib.load(open("/root/.codex/config.toml","rb")); print(d["tui"]["alternate_screen"]); print(d["tui"]["raw_output_mode"])'
jq -r '.tui' /root/.claude/settings.json
codex --version
claude --version
```

Expected:

```text
on
100000
never
True
fullscreen
codex-cli 0.145.0
2.1.220 (Claude Code)
```

- [ ] **Step 8: Hand off the physical iPad verification**

Tell the user:

1. Exit and restart the current Codex process so it reads the new TUI settings.
2. Restart any Claude Code process that was already open before tmux mouse mode
   changed.
3. Produce more than one screen of output in each CLI.
4. Use the iPad trackpad or a two-finger touchscreen gesture to scroll up and
   down.
5. Confirm that the conversation moves and the prompt does not rotate to an
   older submitted message.
6. Press `q` if Codex remains in tmux copy mode after reviewing older output.

- [ ] **Step 9: Confirm repository scope**

Run:

```bash
git status --short
```

Expected: no implementation changes under `/root/sextant`; the runtime
configuration targets are intentionally outside the repository. Do not create
an implementation commit for home-directory configuration files.
