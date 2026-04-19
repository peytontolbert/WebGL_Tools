import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def run_cmd(args, *, cwd=REPO_ROOT, input_text=None):
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        input=input_text,
        capture_output=True,
        check=False,
    )


class ChronoWasmStatusAssertTests(unittest.TestCase):
    @staticmethod
    def _base_status_with_bridge(bridge_line: str) -> str:
        return textwrap.dedent(
            f"""
            chrono vehicle spec: streetcarpack_nissan_350z/vehicle/vehicle.json
            pre-spawn geom: wb=2.649 tf=1.534 tr=1.544 src=ac_track_target hold=no
            sim: wheelbase=2.649 trackF=1.534 trackR=1.544
            raw spindle: api=ok finite=yes plausible=yes canon=ok filtered=yes badFrames=0/45
            {bridge_line}
            hardpoints: front(applied=yes geomOk=yes partial=no) rear(applied=yes geomOk=yes partial=no)
            """
        ).strip()

    def test_bridge_fail_matrix_per_wheel_and_stage(self):
        wheels = ["FL", "FR", "RL", "RR"]
        stages = ["direct_invalid", "fallback_invalid"]
        for wheel in wheels:
            for stage in stages:
                with self.subTest(wheel=wheel, stage=stage):
                    status = self._base_status_with_bridge(
                        f"bridge spindle: reason=fail_no_cache allWheels=no sane=no failWheel={wheel} "
                        f"failStage={stage} directMask=0 fallbackMask=0 wb=0.000 tf=0.000 tr=0.000"
                    )
                    proc = run_cmd([PYTHON, "tools/chrono_wasm_status_assert.py"], input_text=status)
                    self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
                    self.assertIn("bridge spindle reason is fail_no_cache", proc.stdout)
                    self.assertIn("bridge spindle allWheels=no", proc.stdout)
                    self.assertIn("bridge spindle sane=no", proc.stdout)
                    self.assertIn(
                        f"bridge spindle first failure: wheel={wheel} stage={stage}",
                        proc.stdout,
                    )
                    self.assertIn("bridge spindle has no valid wheels in direct or fallback paths", proc.stdout)

    def test_bridge_mask_matrix_rejects_out_of_range_masks(self):
        for direct_mask, fallback_mask in [(-1, 0), (0, -1), (16, 0), (0, 16), (99, 99)]:
            with self.subTest(direct=direct_mask, fallback=fallback_mask):
                status = self._base_status_with_bridge(
                    "bridge spindle: reason=ok allWheels=yes sane=yes failWheel=- failStage=none "
                    f"directMask={direct_mask} fallbackMask={fallback_mask} wb=2.649 tf=1.534 tr=1.544"
                )
                proc = run_cmd([PYTHON, "tools/chrono_wasm_status_assert.py"], input_text=status)
                self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
                self.assertIn("bridge spindle masks out of range", proc.stdout)

    def test_fails_on_alert_style_unhealthy_spindle_stream(self):
        fixture = REPO_ROOT / "tests" / "fixtures" / "chrono_status_unhealthy_raw_stream_alert.txt"
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py", "--allow-missing-spindle-health"],
            input_text=fixture.read_text(encoding="utf-8"),
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("raw spindle bad frames reported: 95", proc.stdout)
        self.assertIn("bridge spindle reason is fail_no_cache", proc.stdout)
        self.assertIn("bridge spindle allWheels=no", proc.stdout)
        self.assertIn("bridge spindle sane=no", proc.stdout)
        self.assertIn("bridge spindle first failure: wheel=FL stage=fallback_invalid", proc.stdout)
        self.assertIn("bridge spindle has no valid wheels in direct or fallback paths", proc.stdout)

    def test_fails_on_real_captured_status_fixture(self):
        fixture = REPO_ROOT / "tests" / "fixtures" / "chrono_status_bad_2026-02-28_caseB.txt"
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py", "--status", str(fixture), "--allow-partial-hardpoints"],
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("dWb too high", proc.stdout)
        self.assertIn("dTf too high", proc.stdout)
        self.assertIn("dTr too high", proc.stdout)
        self.assertIn("bridge spindle reason is fail_no_cache", proc.stdout)
        self.assertIn("bridge spindle has no valid wheels in direct or fallback paths", proc.stdout)

    def test_fails_on_unhealthy_raw_spindle_stream(self):
        status = textwrap.dedent(
            """
            chrono vehicle spec: streetcarpack_nissan_350z/vehicle/vehicle.json
            pre-spawn geom: wb=2.649 tf=1.534 tr=1.544 src=ac_track_target hold=no
            sim: wheelbase=2.649 trackF=1.534 trackR=1.544
            raw spindle: api=bad finite=no plausible=no canon=bad filtered=no badFrames=973/45
            bridge spindle: reason=fail_no_cache allWheels=no sane=no failWheel=FL failStage=fallback_invalid directMask=0 fallbackMask=0 wb=0.000 tf=0.000 tr=0.000
            hardpoints: front(applied=yes geomOk=yes partial=no) rear(applied=yes geomOk=yes partial=no)
            """
        ).strip()
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py"],
            input_text=status,
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("raw spindle api is bad", proc.stdout)
        self.assertIn("bridge spindle reason is fail_no_cache", proc.stdout)
        self.assertIn("bridge spindle has no valid wheels in direct or fallback paths", proc.stdout)

    def test_fails_on_large_geometry_mismatch(self):
        status = textwrap.dedent(
            """
            chrono vehicle spec: streetcarpack_nissan_350z/vehicle/vehicle.json
            pre-spawn geom: wb=2.649 tf=1.534 tr=1.544 src=ac_track_target hold=no
            sim: wheelbase=3.001 trackF=0.869 trackR=0.715
            raw spindle: api=ok finite=yes plausible=yes canon=ok filtered=yes badFrames=0/45
            bridge spindle: reason=ok allWheels=yes sane=yes failWheel=— failStage=none directMask=15 fallbackMask=15 wb=3.001 tf=0.869 tr=0.715
            hardpoints: front(applied=yes geomOk=yes partial=yes) rear(applied=yes geomOk=yes partial=yes)
            """
        ).strip()
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py"],
            input_text=status,
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("dWb too high", proc.stdout)
        self.assertIn("dTf too high", proc.stdout)
        self.assertIn("dTr too high", proc.stdout)
        self.assertIn("partial hardpoints detected", proc.stdout)

    def test_fails_on_legacy_track_source(self):
        status = textwrap.dedent(
            """
            chrono vehicle spec: streetcarpack_nissan_350z/vehicle/vehicle.json
            pre-spawn geom: wb=2.649 tf=1.534 tr=1.544 src=spindle_com_legacy hold=no
            sim: wheelbase=2.649 trackF=1.534 trackR=1.544
            raw spindle: api=ok finite=yes plausible=yes canon=ok filtered=yes badFrames=0/45
            bridge spindle: reason=ok allWheels=yes sane=yes failWheel=— failStage=none directMask=15 fallbackMask=15 wb=2.649 tf=1.534 tr=1.544
            hardpoints: front(applied=yes geomOk=yes partial=no) rear(applied=yes geomOk=yes partial=no)
            """
        ).strip()
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py"],
            input_text=status,
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("pre-spawn track source is spindle_com_legacy", proc.stdout)

    def test_fails_on_dead_drivetrain_under_forward_throttle(self):
        status = textwrap.dedent(
            """
            chrono vehicle spec: streetcarpack_nissan_350z/vehicle/vehicle.json
            pre-spawn geom: wb=2.649 tf=1.534 tr=1.544 src=ac_track_target hold=no
            sim: wheelbase=2.649 trackF=1.534 trackR=1.544
            raw spindle: api=ok finite=yes plausible=yes canon=ok filtered=yes badFrames=0/45
            bridge spindle: reason=ok allWheels=yes sane=yes failWheel=— failStage=none directMask=15 fallbackMask=15 wb=2.649 tf=1.534 tr=1.544
            hardpoints: front(applied=yes geomOk=yes partial=no) rear(applied=yes geomOk=yes partial=no)
            throttle: 1.00   brake: 0.00   steer: 0.00 (~0°)
            powertrain: trans=true hasEngine=true type=0 shiftMode=0 driveMode=1 targetDrive=1 gear=1 driveshaftNm=0 motorshaftRpm=0
            powertrain detail: engineRpm=0 engineNm=0 tc=no tcOutNm=0 tcOutRpm=0 tcSlip=0.000
            powertrain source: authored_simplemap inertFrames=89 clutchCmd=0 flipTried=no inputsMode=setControls
            wheel omega(rad/s): FL=0.0 FR=0.0 RL=0.0 RR=0.0
            """
        ).strip()
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py"],
            input_text=status,
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("dead drivetrain under forward throttle", proc.stdout)

    def test_passes_when_wheels_spin_under_forward_throttle(self):
        status = textwrap.dedent(
            """
            chrono vehicle spec: streetcarpack_nissan_350z/vehicle/vehicle.json
            pre-spawn geom: wb=2.649 tf=1.534 tr=1.544 src=ac_track_target hold=no
            sim: wheelbase=2.649 trackF=1.534 trackR=1.544
            raw spindle: api=ok finite=yes plausible=yes canon=ok filtered=yes badFrames=0/45
            bridge spindle: reason=ok allWheels=yes sane=yes failWheel=— failStage=none directMask=15 fallbackMask=15 wb=2.649 tf=1.534 tr=1.544
            hardpoints: front(applied=yes geomOk=yes partial=no) rear(applied=yes geomOk=yes partial=no)
            throttle: 1.00   brake: 0.00   steer: 0.00 (~0°)
            powertrain: trans=true hasEngine=true type=0 shiftMode=0 driveMode=1 targetDrive=1 gear=1 driveshaftNm=185 motorshaftRpm=1220
            powertrain detail: engineRpm=1450 engineNm=210 tc=no tcOutNm=0 tcOutRpm=0 tcSlip=0.000
            powertrain source: authored_json inertFrames=0 clutchCmd=0 flipTried=no inputsMode=setControls
            wheel omega(rad/s): FL=10.8 FR=10.5 RL=10.2 RR=10.1
            """
        ).strip()
        proc = run_cmd(
            [PYTHON, "tools/chrono_wasm_status_assert.py"],
            input_text=status,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("PASS", proc.stdout)


class ChronoExportGeometryAuditTests(unittest.TestCase):
    def _write_json(self, path: Path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _make_stream_root(self, *, partial_front=False, partial_rear=False):
        td = tempfile.TemporaryDirectory()
        root = Path(td.name)
        self.addCleanup(td.cleanup)

        params = {
            "entries": [
                {"file": "data/suspensions.ini", "section": "BASIC", "key": "WHEELBASE", "value": "2.649"},
                {"file": "data/suspensions.ini", "section": "FRONT", "key": "TRACK", "value": "1.534"},
                {"file": "data/suspensions.ini", "section": "REAR", "key": "TRACK", "value": "1.544"},
            ]
        }
        manifest = {
            "vehicleFsRel": "car/vehicle/vehicle.json",
        }
        vehicle = {
            "Wheelbase": 2.649,
            "Axles": [
                {"Suspension Input File": "car/suspension/front.json"},
                {"Suspension Input File": "car/suspension/rear.json"},
            ],
        }
        front = {
            "Spindle": {"COM": [0.0, 0.767, 0.0]},
            "AC Suspension": {
                "track_target_m": 1.534,
                "hardpoints_applied": True,
                "hardpoints_geom_ok": True,
                "hardpoints_partial_ac": partial_front,
            },
        }
        rear = {
            "Spindle": {"COM": [0.0, 0.772, 0.0]},
            "AC Suspension": {
                "track_target_m": 1.544,
                "hardpoints_applied": True,
                "hardpoints_geom_ok": True,
                "hardpoints_partial_ac": partial_rear,
            },
        }

        self._write_json(root / "ac_raw" / "params.raw.json", params)
        self._write_json(root / "normalized" / "chrono" / "manifest.json", manifest)
        self._write_json(root / "normalized" / "chrono" / "car" / "vehicle" / "vehicle.json", vehicle)
        self._write_json(root / "normalized" / "chrono" / "car" / "suspension" / "front.json", front)
        self._write_json(root / "normalized" / "chrono" / "car" / "suspension" / "rear.json", rear)
        return root

    def test_passes_with_consistent_geometry(self):
        root = self._make_stream_root(partial_front=False, partial_rear=False)
        proc = run_cmd(
            [PYTHON, "tools/chrono_export_geometry_audit.py", "--stream-root", str(root)],
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("PASS", proc.stdout)

    def test_fails_when_partial_hardpoints_disallowed(self):
        root = self._make_stream_root(partial_front=True, partial_rear=False)
        proc = run_cmd(
            [PYTHON, "tools/chrono_export_geometry_audit.py", "--stream-root", str(root)],
        )
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("front hardpoints are partial", proc.stdout)

    def test_passes_when_partial_hardpoints_allowed(self):
        root = self._make_stream_root(partial_front=True, partial_rear=True)
        proc = run_cmd(
            [
                PYTHON,
                "tools/chrono_export_geometry_audit.py",
                "--stream-root",
                str(root),
                "--allow-partial-hardpoints",
            ],
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("PASS", proc.stdout)


if __name__ == "__main__":
    unittest.main()
