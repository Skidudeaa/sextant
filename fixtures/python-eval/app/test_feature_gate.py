"""Unit tests for the feature gate flag registry.

Co-located with the module under test (pytest discovers test_*.py anywhere),
NOT under a tests/ directory — this is the exact layout the test-path penalty
regexes missed before the 2026-05-25 fix.
"""

from app.feature_gate import is_enabled, enable_flag, disable_flag, FLAG_REGISTRY


def test_flag_defaults():
    assert is_enabled("realtime_drafts") is True
    assert is_enabled("episode_tapestry") is False


def test_enable_flag_flips_flag_on():
    disable_flag("source_tracking")
    assert is_enabled("source_tracking") is False
    enable_flag("source_tracking")
    assert is_enabled("source_tracking") is True


def test_disable_flag_flips_flag_off():
    enable_flag("realtime_drafts")
    disable_flag("realtime_drafts")
    assert is_enabled("realtime_drafts") is False


def test_unknown_flag_defaults_to_disabled():
    assert is_enabled("no_such_flag") is False


def test_registry_contains_known_flags():
    for flag in ("episode_tapestry", "realtime_drafts", "source_tracking"):
        assert flag in FLAG_REGISTRY
