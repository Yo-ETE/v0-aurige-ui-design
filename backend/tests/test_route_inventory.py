"""Inventaire fige des routes FastAPI (filet anti-regression du decoupage en routers).

Pour regenerer EXPECTED apres un changement de routes volontaire :
    cd backend && python -c "from tests.test_route_inventory import collect; \
import pprint; pprint.pprint(collect())"
puis coller la liste obtenue dans EXPECTED.
"""

import main
from starlette.routing import WebSocketRoute

_HTTP_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH"}
_INTERNAL_PATHS = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}


def collect() -> list[tuple[str, str]]:
    pairs = set()
    for route in main.fastapi_app.routes:
        path = getattr(route, "path", None)
        if path is None or path in _INTERNAL_PATHS:
            continue
        if isinstance(route, WebSocketRoute):
            pairs.add(("WS", path))
            continue
        for method in getattr(route, "methods", None) or ():
            if method in _HTTP_METHODS:
                pairs.add((method, path))
    return sorted(pairs)


EXPECTED: list[tuple[str, str]] = [
    ('DELETE', '/api/dbc/{dbc_id}'),
    ('DELETE', '/api/dbc/{dbc_id}/message/{can_id}'),
    ('DELETE', '/api/dbc/{dbc_id}/signal/{signal_id}'),
    ('DELETE', '/api/known-frames/{fid}'),
    ('DELETE', '/api/missions/{mission_id}'),
    ('DELETE', '/api/missions/{mission_id}/comparisons/{comparison_id}'),
    ('DELETE', '/api/missions/{mission_id}/dbc'),
    ('DELETE', '/api/missions/{mission_id}/dbc/message/{can_id}'),
    ('DELETE', '/api/missions/{mission_id}/dbc/signal/{signal_id}'),
    ('DELETE', '/api/missions/{mission_id}/logs/{log_id}'),
    ('DELETE', '/api/system/backups/{filename}'),
    ('GET', '/api/aud06/blocklist'),
    ('GET', '/api/can/{interface}/status'),
    ('GET', '/api/capture/status'),
    ('GET', '/api/dbc'),
    ('GET', '/api/dbc/{dbc_id}'),
    ('GET', '/api/dbc/{dbc_id}/export'),
    ('GET', '/api/fuzzing/history'),
    ('GET', '/api/fuzzing/status'),
    ('GET', '/api/generator/status'),
    ('GET', '/api/health'),
    ('GET', '/api/inject/status'),
    ('GET', '/api/known-frames'),
    ('GET', '/api/missions'),
    ('GET', '/api/missions/{mission_id}'),
    ('GET', '/api/missions/{mission_id}/comparisons'),
    ('GET', '/api/missions/{mission_id}/comparisons/{comparison_id}'),
    ('GET', '/api/missions/{mission_id}/dbc'),
    ('GET', '/api/missions/{mission_id}/dbc/active'),
    ('GET', '/api/missions/{mission_id}/dbc/export'),
    ('GET', '/api/missions/{mission_id}/export'),
    ('GET', '/api/missions/{mission_id}/logs'),
    ('GET', '/api/missions/{mission_id}/logs-analysis'),
    ('GET', '/api/missions/{mission_id}/logs/{log_id}/content'),
    ('GET', '/api/missions/{mission_id}/logs/{log_id}/download'),
    ('GET', '/api/missions/{mission_id}/logs/{log_id}/download-family'),
    ('GET', '/api/network/ethernet/status'),
    ('GET', '/api/network/hotspot/credentials'),
    ('GET', '/api/network/hotspot/status'),
    ('GET', '/api/network/wifi/saved'),
    ('GET', '/api/network/wifi/scan'),
    ('GET', '/api/network/wifi/status'),
    ('GET', '/api/obd/last-report'),
    ('GET', '/api/replay/status'),
    ('GET', '/api/status'),
    ('GET', '/api/system/apt/output'),
    ('GET', '/api/system/backups'),
    ('GET', '/api/system/backups/{filename}/download'),
    ('GET', '/api/system/branches'),
    ('GET', '/api/system/check-update'),
    ('GET', '/api/system/data-info'),
    ('GET', '/api/system/update/output'),
    ('GET', '/api/system/version'),
    ('GET', '/api/tailscale/status'),
    ('GET', '/missions/{mission_id}/logs/{log_id}/download'),
    ('GET', '/status'),
    ('PATCH', '/api/dbc/{dbc_id}'),
    ('PATCH', '/api/known-frames/{fid}'),
    ('PATCH', '/api/missions/{mission_id}'),
    ('POST', '/api/analysis/auto-detect-signals'),
    ('POST', '/api/analysis/byte-heatmap'),
    ('POST', '/api/analysis/correlate-obd'),
    ('POST', '/api/analysis/family-diff'),
    ('POST', '/api/analysis/inter-id-dependencies'),
    ('POST', '/api/analysis/validate-causality'),
    ('POST', '/api/can/init'),
    ('POST', '/api/can/scan-bitrate'),
    ('POST', '/api/can/send'),
    ('POST', '/api/can/stop'),
    ('POST', '/api/capture/start'),
    ('POST', '/api/capture/stop'),
    ('POST', '/api/dbc'),
    ('POST', '/api/dbc/{dbc_id}/from-mission/{mission_id}'),
    ('POST', '/api/dbc/{dbc_id}/import'),
    ('POST', '/api/dbc/{dbc_id}/message'),
    ('POST', '/api/dbc/{dbc_id}/signal'),
    ('POST', '/api/fuzzing/analyze-crash'),
    ('POST', '/api/fuzzing/compare-logs'),
    ('POST', '/api/fuzzing/crash-recovery'),
    ('POST', '/api/fuzzing/force-cleanup'),
    ('POST', '/api/fuzzing/start'),
    ('POST', '/api/fuzzing/stop'),
    ('POST', '/api/generator/start'),
    ('POST', '/api/generator/stop'),
    ('POST', '/api/inject/start'),
    ('POST', '/api/inject/stop'),
    ('POST', '/api/known-frames'),
    ('POST', '/api/known-frames/{fid}/replay'),
    ('POST', '/api/missions'),
    ('POST', '/api/missions/{mission_id}/compare-logs'),
    ('POST', '/api/missions/{mission_id}/comparisons'),
    ('POST', '/api/missions/{mission_id}/dbc/from-library/{dbc_id}'),
    ('POST', '/api/missions/{mission_id}/dbc/import'),
    ('POST', '/api/missions/{mission_id}/dbc/message'),
    ('POST', '/api/missions/{mission_id}/dbc/signal'),
    ('POST', '/api/missions/{mission_id}/duplicate'),
    ('POST', '/api/missions/{mission_id}/import-log'),
    ('POST', '/api/missions/{mission_id}/logs/create-frame'),
    ('POST', '/api/missions/{mission_id}/logs/{log_id}/co-occurrence'),
    ('POST', '/api/missions/{mission_id}/logs/{log_id}/rename'),
    ('POST', '/api/missions/{mission_id}/logs/{log_id}/split'),
    ('POST', '/api/network/hotspot/credentials'),
    ('POST', '/api/network/hotspot/start'),
    ('POST', '/api/network/hotspot/stop'),
    ('POST', '/api/network/wifi/connect'),
    ('POST', '/api/obd/dtc/clear'),
    ('POST', '/api/obd/dtc/pending'),
    ('POST', '/api/obd/dtc/permanent'),
    ('POST', '/api/obd/dtc/read'),
    ('POST', '/api/obd/freeze-frame'),
    ('POST', '/api/obd/full-scan'),
    ('POST', '/api/obd/pid'),
    ('POST', '/api/obd/pid-read'),
    ('POST', '/api/obd/reset'),
    ('POST', '/api/obd/scan-pids'),
    ('POST', '/api/obd/status'),
    ('POST', '/api/obd/vin'),
    ('POST', '/api/replay/force-cleanup'),
    ('POST', '/api/replay/start'),
    ('POST', '/api/replay/stop'),
    ('POST', '/api/signal-finder/extract-obd-from-log'),
    ('POST', '/api/signal-finder/read-pid'),
    ('POST', '/api/sniffer/start'),
    ('POST', '/api/sniffer/stop'),
    ('POST', '/api/system/apt/update'),
    ('POST', '/api/system/apt/upgrade'),
    ('POST', '/api/system/backup'),
    ('POST', '/api/system/backups/upload'),
    ('POST', '/api/system/backups/{filename}/restore'),
    ('POST', '/api/system/reboot'),
    ('POST', '/api/system/restart-services'),
    ('POST', '/api/system/shutdown'),
    ('POST', '/api/system/update'),
    ('POST', '/api/tailscale/down'),
    ('POST', '/api/tailscale/logout'),
    ('POST', '/api/tailscale/set-exit-node'),
    ('POST', '/api/tailscale/up'),
    ('PUT', '/api/aud06/blocklist'),
    ('PUT', '/api/missions/{mission_id}/logs/{log_id}/tags'),
    ('WS', '/ws/candump'),
    ('WS', '/ws/cansniffer'),
    ('WS', '/ws/signal-finder'),
]


def test_route_inventory_unchanged():
    current = set(collect())
    expected = set(EXPECTED)
    missing = expected - current
    added = current - expected
    assert current == expected, f"missing={sorted(missing)} added={sorted(added)}"
