"""Integration-style tests exercising staged feature-flag rollout.

A second co-located test_*.py whose filename also contains "flag" — without the
test-path penalty this file's text frequency for "flag" rivals the canonical
feature_gate.py module and crowds it out of the top rank.
"""

from app.feature_gate import enable_flag, disable_flag, is_enabled, all_flags, FLAG_REGISTRY


def test_staged_flag_rollout_enables_each_flag():
    for flag in list(FLAG_REGISTRY):
        enable_flag(flag)
        assert is_enabled(flag) is True


def test_flag_rollout_is_idempotent():
    enable_flag("episode_tapestry")
    enable_flag("episode_tapestry")
    assert is_enabled("episode_tapestry") is True


def test_flag_rollback_disables_flag():
    enable_flag("source_tracking")
    disable_flag("source_tracking")
    assert is_enabled("source_tracking") is False


def test_rollout_snapshot_reports_every_flag():
    snapshot = all_flags()
    for flag in FLAG_REGISTRY:
        assert flag in snapshot
