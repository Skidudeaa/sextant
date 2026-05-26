"""Top-level service wiring — gives the dependency graph real fan-in edges
from a non-test consumer of the modules above."""

from app.feature_gate import is_enabled
from app.broker import CorrectionBroker
from app.router import RequestRouter


def build_service() -> RequestRouter:
    """Wire a router whose behavior is gated by feature flags."""
    router = RequestRouter()
    broker = CorrectionBroker()

    def corrections_handler(_path: str):
        if is_enabled("correction_broker"):
            return broker
        return None

    router.add_route("/corrections", corrections_handler)
    return router
