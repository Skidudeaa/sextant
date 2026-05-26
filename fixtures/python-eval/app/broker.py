"""Message broker: routes correction events to registered subscribers."""

from typing import Callable, List


class CorrectionBroker:
    """Fan-out broker that dispatches correction events to subscribers."""

    def __init__(self) -> None:
        self._subscribers: List[Callable[[dict], None]] = []

    def subscribe(self, handler: Callable[[dict], None]) -> None:
        """Register a handler to receive dispatched correction events."""
        self._subscribers.append(handler)

    def dispatch(self, event: dict) -> int:
        """Dispatch a correction event to every subscriber; return fan-out count."""
        for handler in self._subscribers:
            handler(event)
        return len(self._subscribers)
