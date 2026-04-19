from __future__ import annotations

import hashlib


def seed_to_u32(seed: str) -> int:
    s = (seed or "").encode("utf-8")
    h = hashlib.sha256(s).digest()
    return int.from_bytes(h[:4], "little", signed=False)


class Mulberry32:
    """
    Matches the general shape of the JS mulberry32 RNG used in runtime `procedural_ai_city.js`.
    """

    def __init__(self, seed_u32: int):
        self._a = int(seed_u32) & 0xFFFFFFFF

    def rand01(self) -> float:
        a = self._a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = (a ^ (a >> 15)) * (1 | a)
        t &= 0xFFFFFFFF
        t ^= t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)
        t &= 0xFFFFFFFF
        self._a = a
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    def randint(self, lo: int, hi: int) -> int:
        if hi <= lo:
            return int(lo)
        r = self.rand01()
        return lo + int(r * (hi - lo + 1))

    def choice(self, xs):
        if not xs:
            raise ValueError("choice() on empty list")
        return xs[self.randint(0, len(xs) - 1)]

    def uniform(self, a: float, b: float) -> float:
        return float(a) + (float(b) - float(a)) * self.rand01()

