import json
import math
import pytest
from unittest.mock import AsyncMock, MagicMock


@pytest.mark.asyncio
async def test_query_per_pod_returns_dict_of_pod_values():
    from services.prometheus_collector import _query_per_pod

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "data": {
            "result": [
                {"metric": {"pod": "omb-worker-0"}, "value": [0, "3800.5"]},
                {"metric": {"pod": "omb-worker-1"}, "value": [0, "1200.3"]},
            ]
        }
    }
    client = AsyncMock()
    client.get.return_value = mock_resp

    result = await _query_per_pod(client, "http://prom:9090", "some_query")

    assert result == {"omb-worker-0": pytest.approx(3800.5), "omb-worker-1": pytest.approx(1200.3)}


@pytest.mark.asyncio
async def test_query_per_pod_returns_empty_on_non_200():
    from services.prometheus_collector import _query_per_pod

    mock_resp = MagicMock()
    mock_resp.status_code = 500
    client = AsyncMock()
    client.get.return_value = mock_resp

    result = await _query_per_pod(client, "http://prom:9090", "some_query")
    assert result == {}


@pytest.mark.asyncio
async def test_query_per_pod_skips_nan_values():
    from services.prometheus_collector import _query_per_pod

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "data": {
            "result": [
                {"metric": {"pod": "omb-worker-0"}, "value": [0, "NaN"]},
                {"metric": {"pod": "omb-worker-1"}, "value": [0, "1200.3"]},
            ]
        }
    }
    client = AsyncMock()
    client.get.return_value = mock_resp

    result = await _query_per_pod(client, "http://prom:9090", "some_query")
    assert "omb-worker-0" not in result
    assert result["omb-worker-1"] == pytest.approx(1200.3)


@pytest.mark.asyncio
async def test_query_per_pod_returns_empty_on_exception():
    from services.prometheus_collector import _query_per_pod

    client = AsyncMock()
    client.get.side_effect = Exception("network error")

    result = await _query_per_pod(client, "http://prom:9090", "some_query")
    assert result == {}
