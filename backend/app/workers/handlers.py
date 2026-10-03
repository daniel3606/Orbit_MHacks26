"""Job handlers. Only kinds registered here are claimed; others stay queued.

`refresh_recommendations` is intentionally not registered yet: ranking is
PRD Phase 4 and must not be faked. Those jobs remain queued (coalesced to one
per user) until a real handler exists.
"""

from app.state.dto import JobV1
from app.state.gateway import SpacetimeGateway
from app.workers.runner import JobFailure


class BackendCheckHandler:
    """Proves the authorized round trip: the worker reads the job owner's
    profile through the lease-scoped `worker_job_profiles` view and reports
    the version it observed back through `complete_job`."""

    kind = "backend_check"

    def __init__(self, worker_id: str):
        self._worker_id = worker_id

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> str:
        profiles = await gateway.worker_job_profiles()
        profile = next((p for p in profiles if p.owner == job.owner), None)
        observed = profile.profile_version if profile else 0
        if observed < job.input_version:
            # The view must reflect at least the version the job was created against.
            raise JobFailure("profile_not_visible", retryable=True)
        return f"worker={self._worker_id};observed_profile_version={observed}"


def default_handlers(worker_id: str) -> dict[str, BackendCheckHandler]:
    handler = BackendCheckHandler(worker_id)
    return {handler.kind: handler}
