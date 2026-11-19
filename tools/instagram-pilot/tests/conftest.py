"""Las pruebas no tocan la red: cualquier intento de conexión o resolución DNS falla."""

import socket

import pytest


class NetworkBlocked(RuntimeError):
    pass


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise NetworkBlocked("las pruebas no deben usar la red")

    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)


@pytest.fixture(autouse=True)
def isolated_state(monkeypatch, tmp_path):
    """El estado del piloto (bloqueo, sesiones, ejecuciones) va a una carpeta temporal."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "localappdata"))
