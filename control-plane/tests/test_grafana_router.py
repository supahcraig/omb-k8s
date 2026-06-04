import pytest
from unittest.mock import MagicMock, patch


def _make_ingress(hostname=None, ip=None):
    ing = MagicMock()
    ing.hostname = hostname
    ing.ip = ip
    return ing


def _make_svc(ingress_list):
    svc = MagicMock()
    svc.spec.type = "LoadBalancer"
    svc.status.load_balancer.ingress = ingress_list
    return svc


def test_returns_hostname_when_present():
    from routers.grafana import _get_grafana_url
    svc = _make_svc([_make_ingress(hostname="abc.elb.amazonaws.com")])
    result = _get_grafana_url(svc)
    assert result == "http://abc.elb.amazonaws.com"


def test_returns_ip_when_no_hostname():
    from routers.grafana import _get_grafana_url
    svc = _make_svc([_make_ingress(hostname=None, ip="1.2.3.4")])
    result = _get_grafana_url(svc)
    assert result == "http://1.2.3.4"


def test_returns_none_when_no_ingress():
    from routers.grafana import _get_grafana_url
    svc = _make_svc([])
    result = _get_grafana_url(svc)
    assert result is None


def test_returns_none_when_ingress_is_none():
    from routers.grafana import _get_grafana_url
    svc = _make_svc(None)
    result = _get_grafana_url(svc)
    assert result is None


def test_returns_none_when_not_loadbalancer():
    from routers.grafana import _get_grafana_url
    svc = MagicMock()
    svc.spec.type = "ClusterIP"
    result = _get_grafana_url(svc)
    assert result is None
