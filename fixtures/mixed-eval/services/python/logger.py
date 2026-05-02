"""Python-side Logger. Intentional collision with Sources/Swift/Logger.swift.

mixed-002 expects the Swift Logger to rank above this when the query has a
.swift path hint.
"""


class Logger:
    """Lightweight wrapper around the standard logging module."""

    def __init__(self, name: str) -> None:
        self.name = name

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def error(self, message: str) -> None:
        pass
