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


@pytest.mark.asyncio
async def test_collect_sample_stores_net_tx_per_pod(monkeypatch):
    """_collect_sample writes worker_net_tx_per_pod JSON to the DB row."""
    from services import prometheus_collector

    captured = {}

    async def fake_query_per_pod(client, url, query):
        if "container_network_transmit_bytes_total" in query:
            return {"omb-worker-0": 52428800.0, "omb-worker-1": 31457280.0}
        return {}

    async def fake_query(client, url, query):
        return None

    class FakeSession:
        def __init__(self): self.added = []
        def add(self, obj): self.added.append(obj); captured['sample'] = obj
        async def commit(self): pass
        async def rollback(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass

    monkeypatch.setattr(prometheus_collector, "_query_per_pod", fake_query_per_pod)
    monkeypatch.setattr(prometheus_collector, "_query", fake_query)
    monkeypatch.setattr(prometheus_collector, "AsyncSessionLocal", FakeSession)

    import httpx
    async with httpx.AsyncClient() as client:
        await prometheus_collector._collect_sample(client, "http://prom", "omb", 1, 0, 4.0)

    sample = captured['sample']
    assert sample.worker_net_tx_per_pod is not None
    parsed = json.loads(sample.worker_net_tx_per_pod)
    assert parsed["omb-worker-0"] == pytest.approx(52428800.0)
    assert parsed["omb-worker-1"] == pytest.approx(31457280.0)


@pytest.mark.asyncio
async def test_collect_sample_stores_net_drop_per_pod(monkeypatch):
    """_collect_sample writes worker_net_drop_per_pod JSON to the DB row."""
    from services import prometheus_collector

    captured = {}

    async def fake_query_per_pod(client, url, query):
        if "container_network_transmit_packets_dropped_total" in query:
            return {"omb-worker-2": 3.2}
        return {}

    async def fake_query(client, url, query):
        return None

    class FakeSession:
        def __init__(self): self.added = []
        def add(self, obj): self.added.append(obj); captured['sample'] = obj
        async def commit(self): pass
        async def rollback(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass

    monkeypatch.setattr(prometheus_collector, "_query_per_pod", fake_query_per_pod)
    monkeypatch.setattr(prometheus_collector, "_query", fake_query)
    monkeypatch.setattr(prometheus_collector, "AsyncSessionLocal", FakeSession)

    import httpx
    async with httpx.AsyncClient() as client:
        await prometheus_collector._collect_sample(client, "http://prom", "omb", 1, 0, 4.0)

    sample = captured['sample']
    assert sample.worker_net_drop_per_pod is not None
    parsed = json.loads(sample.worker_net_drop_per_pod)
    assert parsed["omb-worker-2"] == pytest.approx(3.2)


@pytest.mark.asyncio
async def test_collect_sample_net_columns_null_when_queries_return_empty(monkeypatch):
    """worker_net_* columns are None when per-pod queries return empty dicts."""
    from services import prometheus_collector

    captured = {}

    async def fake_query_per_pod(client, url, query):
        return {}

    async def fake_query(client, url, query):
        return None

    class FakeSession:
        def __init__(self): self.added = []
        def add(self, obj): self.added.append(obj); captured['sample'] = obj
        async def commit(self): pass
        async def rollback(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass

    monkeypatch.setattr(prometheus_collector, "_query_per_pod", fake_query_per_pod)
    monkeypatch.setattr(prometheus_collector, "_query", fake_query)
    monkeypatch.setattr(prometheus_collector, "AsyncSessionLocal", FakeSession)

    import httpx
    async with httpx.AsyncClient() as client:
        await prometheus_collector._collect_sample(client, "http://prom", "omb", 1, 0, 4.0)

    sample = captured['sample']
    assert sample.worker_net_tx_per_pod is None
    assert sample.worker_net_drop_per_pod is None
