"""Synthetic Python app package for the sextant python-eval corpus.

The re-exports below are the B3 guard structure: a symbol defined in a module
(CorrectionBroker in app/broker.py) is re-exported through this __init__.py
barrel. A query for the symbol must surface the DEFINING module, not the barrel
shim — on a large real repo the merge layer evicted the def in favor of the
barrel (graph score ~100 lost to the barrel's zoekt-corroborated ~500). The
deterministic function-level guard for that eviction lives in
test/merge-results.test.js; this barrel keeps the fixture structurally honest.
"""

from app.broker import CorrectionBroker
from app.router import RequestRouter

__all__ = ["CorrectionBroker", "RequestRouter"]
