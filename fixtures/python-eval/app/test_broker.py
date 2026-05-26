"""Tests for the CorrectionBroker dispatch fan-out.

Co-located test_*.py. For a clean symbol query like "CorrectionBroker" the
def-site in broker.py should still win on its own — this case checks the
penalty does not over-fire and bury a symbol that genuinely has a strong
definition signal.
"""

from app.broker import CorrectionBroker


def test_dispatch_reaches_every_subscriber():
    broker = CorrectionBroker()
    seen = []
    broker.subscribe(lambda e: seen.append(e))
    broker.subscribe(lambda e: seen.append(e))
    count = broker.dispatch({"id": 1})
    assert count == 2
    assert len(seen) == 2


def test_dispatch_with_no_subscribers_returns_zero():
    broker = CorrectionBroker()
    assert broker.dispatch({"id": 2}) == 0
