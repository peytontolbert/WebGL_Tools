#!/usr/bin/env python3
"""
Generate a small Mixamo-named BVH motion for testing retargeting.

Why this exists:
- The repo's retarget pipeline expects a source motion file (BVH/FBX/GLB).
- When you don't have real motion yet, this creates a minimal BVH with a
  Mixamo-ish bone naming scheme that matches `tools/rigging/mappings/example_map.json`.

This is NOT meant to look good. It's meant to be a "plumbing test" asset.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Node:
    name: str
    offset: tuple[float, float, float]
    channels: list[str]  # BVH channels order
    children: list["Node"] = field(default_factory=list)
    end_site_offset: tuple[float, float, float] | None = None

    @property
    def channel_count(self) -> int:
        return len(self.channels)


def _mixamo_skeleton() -> Node:
    # Very rough human-ish offsets (centimeters-ish). BVH units are arbitrary for our use.
    # Names chosen to match common Mixamo bone names used by `example_map.json`.
    spine = Node(
        name="Spine",
        offset=(0.0, 10.0, 0.0),
        channels=["Zrotation", "Xrotation", "Yrotation"],
        children=[
            Node(
                name="Spine1",
                offset=(0.0, 10.0, 0.0),
                channels=["Zrotation", "Xrotation", "Yrotation"],
                children=[
                    Node(
                        name="Neck",
                        offset=(0.0, 8.0, 0.0),
                        channels=["Zrotation", "Xrotation", "Yrotation"],
                        children=[
                            Node(
                                name="Head",
                                offset=(0.0, 6.0, 0.0),
                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                end_site_offset=(0.0, 6.0, 0.0),
                            )
                        ],
                    ),
                    Node(
                        name="LeftShoulder",
                        offset=(4.0, 8.0, 0.0),
                        channels=["Zrotation", "Xrotation", "Yrotation"],
                        children=[
                            Node(
                                name="LeftArm",
                                offset=(10.0, 0.0, 0.0),
                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                children=[
                                    Node(
                                        name="LeftForeArm",
                                        offset=(10.0, 0.0, 0.0),
                                        channels=["Zrotation", "Xrotation", "Yrotation"],
                                        children=[
                                            Node(
                                                name="LeftHand",
                                                offset=(8.0, 0.0, 0.0),
                                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                                end_site_offset=(5.0, 0.0, 0.0),
                                            )
                                        ],
                                    )
                                ],
                            )
                        ],
                    ),
                    Node(
                        name="RightShoulder",
                        offset=(-4.0, 8.0, 0.0),
                        channels=["Zrotation", "Xrotation", "Yrotation"],
                        children=[
                            Node(
                                name="RightArm",
                                offset=(-10.0, 0.0, 0.0),
                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                children=[
                                    Node(
                                        name="RightForeArm",
                                        offset=(-10.0, 0.0, 0.0),
                                        channels=["Zrotation", "Xrotation", "Yrotation"],
                                        children=[
                                            Node(
                                                name="RightHand",
                                                offset=(-8.0, 0.0, 0.0),
                                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                                end_site_offset=(-5.0, 0.0, 0.0),
                                            )
                                        ],
                                    )
                                ],
                            )
                        ],
                    ),
                ],
            )
        ],
    )

    left_leg = Node(
        name="LeftUpLeg",
        offset=(4.0, -10.0, 0.0),
        channels=["Zrotation", "Xrotation", "Yrotation"],
        children=[
            Node(
                name="LeftLeg",
                offset=(0.0, -20.0, 0.0),
                channels=["Zrotation", "Xrotation", "Yrotation"],
                children=[
                    Node(
                        name="LeftFoot",
                        offset=(0.0, -20.0, 2.0),
                        channels=["Zrotation", "Xrotation", "Yrotation"],
                        children=[
                            Node(
                                name="LeftToeBase",
                                offset=(0.0, 0.0, 8.0),
                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                end_site_offset=(0.0, 0.0, 5.0),
                            )
                        ],
                    )
                ],
            )
        ],
    )

    right_leg = Node(
        name="RightUpLeg",
        offset=(-4.0, -10.0, 0.0),
        channels=["Zrotation", "Xrotation", "Yrotation"],
        children=[
            Node(
                name="RightLeg",
                offset=(0.0, -20.0, 0.0),
                channels=["Zrotation", "Xrotation", "Yrotation"],
                children=[
                    Node(
                        name="RightFoot",
                        offset=(0.0, -20.0, 2.0),
                        channels=["Zrotation", "Xrotation", "Yrotation"],
                        children=[
                            Node(
                                name="RightToeBase",
                                offset=(0.0, 0.0, 8.0),
                                channels=["Zrotation", "Xrotation", "Yrotation"],
                                end_site_offset=(0.0, 0.0, 5.0),
                            )
                        ],
                    )
                ],
            )
        ],
    )

    root = Node(
        name="Hips",
        offset=(0.0, 90.0, 0.0),
        channels=["Xposition", "Yposition", "Zposition", "Zrotation", "Xrotation", "Yrotation"],
        children=[spine, left_leg, right_leg],
    )
    return root


def _write_node_lines(node: Node, indent: int, *, is_root: bool) -> list[str]:
    pad = "  " * indent
    kind = "ROOT" if is_root else "JOINT"
    lines: list[str] = []
    lines.append(f"{pad}{kind} {node.name}")
    lines.append(f"{pad}" + "{")
    lines.append(f"{pad}  OFFSET {node.offset[0]:.6f} {node.offset[1]:.6f} {node.offset[2]:.6f}")
    lines.append(f"{pad}  CHANNELS {len(node.channels)} " + " ".join(node.channels))
    for ch in node.children:
        lines.extend(_write_node_lines(ch, indent + 1, is_root=False))
    if node.end_site_offset is not None:
        lines.append(f"{pad}  End Site")
        lines.append(f"{pad}  " + "{")
        ox, oy, oz = node.end_site_offset
        lines.append(f"{pad}    OFFSET {ox:.6f} {oy:.6f} {oz:.6f}")
        lines.append(f"{pad}  " + "}")
    lines.append(f"{pad}" + "}")
    return lines


def _flatten_channel_nodes(node: Node) -> list[Node]:
    out = [node]
    for c in node.children:
        out.extend(_flatten_channel_nodes(c))
    return out


def _frame_values(nodes: list[Node], t: float, *, mode: str) -> list[float]:
    """
    Return channel values in the exact BVH channel order.

    mode:
      - idle: all zeros
      - breathe: small spine/chest pitch sway so it's not completely static
      - walk: a very rough in-place walk cycle (for plumbing tests)
    """
    vals: list[float] = []
    # 1 cycle/sec feels ok for a test walk at 30fps.
    w = 2.0 * math.pi * 1.0
    for n in nodes:
        if n.name == "Hips":
            # Root position + rotation.
            if mode in ("breathe", "walk"):
                # Very small vertical bob, otherwise zero.
                bob = 0.5 if mode == "breathe" else 1.2
                y = n.offset[1] + (math.sin(t * w) * bob)
                vals.extend([0.0, y, 0.0, 0.0, 0.0, 0.0])
            else:
                vals.extend([0.0, n.offset[1], 0.0, 0.0, 0.0, 0.0])
            continue

        # Default rotation channels.
        rz = rx = ry = 0.0
        if mode == "breathe":
            # Slight chest/neck motion.
            if n.name in ("Spine", "Spine1"):
                rx = math.sin(t * 2.0 * math.pi * 0.25) * 2.0
            elif n.name == "Neck":
                rx = math.sin(t * 2.0 * math.pi * 0.25 + 0.7) * 1.0
            elif n.name in ("LeftShoulder", "RightShoulder"):
                rz = math.sin(t * 2.0 * math.pi * 0.25 + (0.4 if "Left" in n.name else -0.4)) * 1.0
        elif mode == "walk":
            # Extremely rough "walk in place":
            # - legs swing opposite phase
            # - arms swing opposite legs
            # - slight spine counter-motion
            s = math.sin(t * w)
            c = math.cos(t * w)
            # Helper phases
            left = s
            right = -s

            if n.name in ("Spine", "Spine1"):
                rx = -c * 2.0
                rz = s * 1.0
            elif n.name == "Neck":
                rx = -c * 1.0
            elif n.name == "Head":
                rx = c * 0.6

            # Arms (forward/back swing around X)
            elif n.name == "LeftArm":
                rx = (-right) * 22.0
            elif n.name == "RightArm":
                rx = (-left) * 22.0
            elif n.name == "LeftForeArm":
                rx = (-right) * 10.0
            elif n.name == "RightForeArm":
                rx = (-left) * 10.0
            elif n.name in ("LeftShoulder", "RightShoulder"):
                rz = (1.0 if "Left" in n.name else -1.0) * s * 2.0

            # Legs (thigh swing around X, knee bends mostly during "lift" phase)
            elif n.name == "LeftUpLeg":
                rx = left * 28.0
            elif n.name == "RightUpLeg":
                rx = right * 28.0
            elif n.name == "LeftLeg":
                # bend when thigh swings forward
                rx = max(0.0, left) * 32.0
            elif n.name == "RightLeg":
                rx = max(0.0, right) * 32.0
            elif n.name == "LeftFoot":
                rx = -max(0.0, left) * 16.0 + min(0.0, left) * 6.0
            elif n.name == "RightFoot":
                rx = -max(0.0, right) * 16.0 + min(0.0, right) * 6.0
            elif n.name == "LeftToeBase":
                rx = max(0.0, -left) * 8.0
            elif n.name == "RightToeBase":
                rx = max(0.0, -right) * 8.0

        # Most BVH rigs use Z, X, Y rotation order (we declare that order), so emit accordingly.
        for ch in n.channels:
            if ch.endswith("position"):
                vals.append(0.0)
            elif ch == "Zrotation":
                vals.append(rz)
            elif ch == "Xrotation":
                vals.append(rx)
            elif ch == "Yrotation":
                vals.append(ry)
            else:
                vals.append(0.0)
    return vals


def main() -> int:
    ap = argparse.ArgumentParser(prog="tools/make_mixamo_idle_bvh.py")
    ap.add_argument("--out", default="outputs/mixamo_idle.bvh", help="Output BVH path (relative to repo root is ok).")
    ap.add_argument("--frames", type=int, default=60, help="Number of frames to emit.")
    ap.add_argument("--fps", type=float, default=30.0, help="Frames per second.")
    ap.add_argument("--mode", choices=["idle", "breathe", "walk"], default="breathe", help="Test motion type.")
    args = ap.parse_args()

    frames = max(2, int(args.frames))
    fps = float(args.fps) if float(args.fps) > 0 else 30.0
    frame_time = 1.0 / fps

    root = _mixamo_skeleton()
    nodes = _flatten_channel_nodes(root)

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = (Path(__file__).resolve().parents[1] / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    lines.append("HIERARCHY")
    lines.extend(_write_node_lines(root, 0, is_root=True))
    lines.append("MOTION")
    lines.append(f"Frames: {frames}")
    lines.append(f"Frame Time: {frame_time:.8f}")

    for i in range(frames):
        t = i * frame_time
        vals = _frame_values(nodes, t, mode=str(args.mode))
        lines.append(" ".join(f"{v:.6f}" for v in vals))

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote BVH: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

