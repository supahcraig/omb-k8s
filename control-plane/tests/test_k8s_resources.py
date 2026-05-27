import pytest
from services.k8s_resources import parse_cpu, parse_memory_mib


class TestParseCpu:
    def test_integer_string(self):
        assert parse_cpu("15") == 15.0

    def test_single_core(self):
        assert parse_cpu("4") == 4.0

    def test_millicores(self):
        assert parse_cpu("500m") == 0.5

    def test_millicores_small(self):
        assert parse_cpu("250m") == 0.25


class TestParseMemoryMib:
    def test_gibibytes(self):
        assert parse_memory_mib("60Gi") == 61440

    def test_8_gib(self):
        assert parse_memory_mib("8Gi") == 8192

    def test_58_gib(self):
        assert parse_memory_mib("58Gi") == 59392

    def test_mibibytes(self):
        assert parse_memory_mib("512Mi") == 512

    def test_1_mib(self):
        assert parse_memory_mib("1Mi") == 1
