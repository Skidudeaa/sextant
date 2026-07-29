# Blink iPad Direct Scrolling Design

Date: 2026-07-28

## Goal

Make a two-finger touchscreen or trackpad gesture in Blink scroll earlier
conversation output directly in both Codex CLI and Claude Code. The gesture
must not rotate through previously submitted prompts.

## Current State

- Blink connects to a shell running inside tmux.
- The active tmux server has mouse support disabled and retains only 2,000
  history lines.
- Codex CLI 0.145.0 uses its default alternate-screen behavior.
- Claude Code 2.1.220 already persists its `fullscreen` renderer.
- Claude Code has no custom keybindings file.

With tmux mouse support disabled, Blink's wheel-like gesture does not reach a
fullscreen application as a mouse event. Codex consequently interprets the
translated input as prompt-history navigation.

## Design

Use a hybrid configuration in which tmux owns the terminal boundary and each
CLI uses the renderer best suited to its scrolling implementation.

### tmux

Create `~/.tmux.conf` with:

```tmux
set -g mouse on
set -g history-limit 100000
```

Apply both options to the currently running tmux server as well as persisting
them for future servers. Mouse mode allows Blink's two-finger gesture to be
handled by tmux and forwarded to applications that request mouse input. The
larger history limit prevents ordinary Codex output from falling out of the
server-side scrollback too quickly.

### Claude Code

Keep `"tui": "fullscreen"` in `~/.claude/settings.json`. Fullscreen Claude Code
requests mouse input and implements its own virtual conversation scrollback.
With tmux mouse mode enabled, tmux forwards Blink's gesture to Claude Code.

No Claude keybinding changes are required.

### Codex CLI

Add the following settings to the existing `[tui]` table in
`~/.codex/config.toml`:

```toml
alternate_screen = "never"
raw_output_mode = true
```

Inline mode keeps Codex output in terminal scrollback instead of isolating it
in the alternate screen. Raw output mode makes that transcript copy- and
scrollback-friendly. With tmux mouse mode enabled, the gesture scrolls tmux's
history rather than becoming up/down input in the Codex composer.

All unrelated Codex and Claude settings remain unchanged.

## Runtime Behavior

The input path becomes:

```text
Blink two-finger gesture
  -> tmux mouse event
  -> Claude Code virtual scrollback when Claude has mouse capture
  -> tmux terminal scrollback when Codex runs inline
```

The tmux settings take effect immediately in the current server. Codex must be
restarted to read its new TUI settings. Existing Claude Code sessions may be
restarted if they were launched before tmux mouse mode was enabled.

## Failure Handling

- If Claude Code does not receive the gesture, confirm `tmux show -g mouse`
  reports `on`. Keyboard `PgUp` and `PgDn` remain a fallback.
- If Codex still rotates prompt history, confirm it was restarted and that its
  effective configuration uses `alternate_screen = "never"`.
- If either app is launched outside tmux, its own terminal behavior applies;
  the tmux configuration cannot affect that session.
- Press `q` to leave tmux copy mode if a scroll leaves Codex viewing old
  output.

## Verification

1. Parse both edited configuration files successfully.
2. Confirm the current tmux server reports mouse mode `on` and history limit
   `100000`.
3. Start fresh Codex and Claude Code sessions inside tmux.
4. Produce more than one screen of output in each application.
5. On the iPad, use a two-finger gesture to move up and down.
6. Confirm that output scrolls and the prompt text does not change to an older
   submitted message.

Steps 1-3 can be verified on the server. Steps 4-6 require the user's physical
Blink/iPad input and are not proven until that live gesture test succeeds.
