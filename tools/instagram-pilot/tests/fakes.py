"""Instagram simulado para las pruebas (datos ficticios, sin red)."""

from __future__ import annotations

from icm_ig_pilot.errors import PilotStop, ProfileFailed, ProfileUnavailable
from icm_ig_pilot.gateway import TargetInfo
from icm_ig_pilot.store import FollowerStub, ProfileDetails


def follower(uid: int, private: bool = False, username: str | None = None) -> dict:
    return {"id": str(uid), "username": username or f"user{uid}", "full_name": f"Nombre {uid}",
            "is_private": private, "is_verified": False}


def profile(uid: int, bio: str = "", external_url: str | None = None, bio_links=None, username=None,
            private=False, contact_keys=None) -> ProfileDetails:
    return ProfileDetails(
        user_id=str(uid), username=username or f"user{uid}", full_name=f"Nombre {uid}", is_private=private,
        biography=bio, external_url=external_url, bio_links=list(bio_links or []), category=None,
        is_business=None, raw_keys=["biography", "id", "is_private", "username"],
        contact_keys=list(contact_keys or []),
    )


class FakeCursor:
    """Cursor por índice. Como Instaloader, al reanudar devuelve de nuevo el último elemento."""

    def __init__(self, gw: FakeGateway, start: int, resumed: bool):
        self.gw = gw
        self.index = start
        self.resumed = resumed

    def next(self):
        self.gw.calls.append(("next", self.index))
        action = self.gw.cursor_errors.pop(self.index, None)
        if action is not None:
            raise action
        if self.index >= len(self.gw.followers):
            return None
        node = self.gw.followers[self.index]
        self.index += 1
        return FollowerStub(node["id"], node["username"].lower(), node.get("full_name"),
                            node.get("is_private"), node.get("is_verified"))

    def state(self):
        # Igual que FrozenNodeIterator: total_index apunta al último elemento entregado.
        return {"index": max(self.index - 1, 0), "user": self.gw.session_user}


class FakeGateway:
    def __init__(self, followers: list[dict], profiles: dict[str, ProfileDetails | Exception] | None = None,
                 session_user: str = "icm_tester"):
        self.followers = followers
        self.profiles = profiles or {}
        self.session_user = session_user
        self.cursor_errors: dict[int, Exception] = {}
        self.calls: list[tuple] = []
        self.expired = False

    def whoami(self):
        return self.session_user

    def resolve_target(self, username):
        return TargetInfo("999", username, "Objetivo", len(self.followers), False)

    def open_followers(self, userid, username, state):
        self.calls.append(("open", state))
        if state is None:
            return FakeCursor(self, 0, resumed=False)
        if self.expired or state.get("user") != self.session_user:
            raise PilotStop("cursor_expired", "simulado")
        return FakeCursor(self, state["index"], resumed=True)

    def fetch_profile(self, stub):
        self.calls.append(("profile", stub.user_id))
        value = self.profiles.get(stub.user_id)
        if isinstance(value, Exception):
            raise value
        if value is None:
            return profile(int(stub.user_id), username=stub.username)
        return value

    def close(self):
        pass


__all__ = ["FakeGateway", "follower", "profile", "PilotStop", "ProfileFailed", "ProfileUnavailable"]
