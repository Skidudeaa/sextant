"""Request router: maps inbound paths to handler callables."""

from typing import Callable, Dict, Optional


class RequestRouter:
    """Minimal path-to-handler router."""

    def __init__(self) -> None:
        self._routes: Dict[str, Callable] = {}

    def add_route(self, path: str, handler: Callable) -> None:
        """Register a handler for an exact path."""
        self._routes[path] = handler

    def route(self, path: str) -> Optional[Callable]:
        """Resolve a path to its registered handler, or None if unmatched."""
        return self._routes.get(path)
