"""Feature gate: the central registry of feature flags and helpers to query them.

This is the canonical place a developer looking for "flags" should land — the
flag registry and the enable/disable/is_enabled helpers all live here.
"""

from typing import Dict

# The single source of truth for which feature flags exist and their defaults.
FLAG_REGISTRY: Dict[str, bool] = {
    "episode_tapestry": False,
    "realtime_drafts": True,
    "source_tracking": False,
    "correction_broker": True,
}


def is_enabled(flag_name: str) -> bool:
    """Return whether a feature flag is currently enabled in the registry."""
    return bool(FLAG_REGISTRY.get(flag_name, False))


def enable_flag(flag_name: str) -> None:
    """Flip a feature flag on. Unknown flags are created as enabled."""
    FLAG_REGISTRY[flag_name] = True


def disable_flag(flag_name: str) -> None:
    """Flip a feature flag off. Unknown flags are created as disabled."""
    FLAG_REGISTRY[flag_name] = False


def all_flags() -> Dict[str, bool]:
    """Return a copy of the full flag registry for inspection."""
    return dict(FLAG_REGISTRY)
