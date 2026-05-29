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
from app.feature_gate import FLAG_REGISTRY, is_enabled
from app.router import RequestRouter

# WHY FLAG_REGISTRY is here: it is a signal-less def (an annotated module
# constant the AST extractor doesn't surface as an export). Re-exporting it
# through this barrel reproduces the B3 constant edge — pre-fix the barrel got
# the canonical-def floor and evicted feature_gate.py (py-penalty-001 FAILs);
# post-fix the barrel is recognized as a re-export (no floor) so feature_gate.py
# competes naturally and wins. py-penalty-001 is the fail-pre/pass-post guard.
__all__ = ["CorrectionBroker", "FLAG_REGISTRY", "is_enabled", "RequestRouter"]
