"""Outbound notification subsystem.

WHY this file exists in the eval corpus: it is the A4 recall-collapse guard.
Its canonical concept tokens (clinician / reminder / escalation / acknowledged)
appear SCATTERED across the body, never as an adjacent phrase, and none of them
appears in the filename ("notifications"). So a natural-language query like
"clinician reminder escalation acknowledged" produces a zoekt PHRASE query that
matches nothing, and the graph filename layer cannot reach this file either.
Pre-fix the canonical file is therefore ABSENT from the hook's candidate set;
the zero-hit AND-fallback in lib/zoekt.js is the only thing that recovers it.
"""

from typing import Dict, List


class ReminderQueue:
    """Holds pending clinician reminders and flushes them on a schedule."""

    def __init__(self) -> None:
        self._pending: List[Dict] = []
        self._acknowledged: Dict[str, bool] = {}

    def enqueue(self, clinician_id: str, message: str) -> None:
        """Queue a reminder destined for a specific clinician."""
        self._pending.append({"clinician": clinician_id, "message": message})

    def acknowledge(self, clinician_id: str) -> None:
        """Mark the most recent reminder as acknowledged by the clinician."""
        self._acknowledged[clinician_id] = True

    def flush(self) -> int:
        """Deliver queued reminders; unacknowledged ones trigger an escalation."""
        delivered = 0
        for item in self._pending:
            clinician = item["clinician"]
            if not self._acknowledged.get(clinician):
                # escalation path: an unacknowledged reminder is escalated
                delivered += 1
        return delivered
