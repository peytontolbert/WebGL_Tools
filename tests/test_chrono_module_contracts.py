from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]


class ChronoModuleContractsTests(unittest.TestCase):
    def test_bridge_exposes_spindle_status_api(self):
        p = REPO_ROOT / "tools" / "chrono_wasm" / "src" / "chrono_vehicle_bridge.cpp"
        txt = p.read_text(encoding="utf-8")
        self.assertIn("cv_get_spindles4_status", txt)
        self.assertIn("spindle_last_fail_wheel", txt)
        self.assertIn("spindle_last_fail_stage", txt)

    def test_js_wrapper_binds_spindle_status(self):
        p = REPO_ROOT / "js" / "runtime" / "project_chrono_wasm_vehicle_sim.js"
        txt = p.read_text(encoding="utf-8")
        self.assertIn("getSpindles4Status", txt)
        self.assertIn("cv_get_spindles4_status", txt)
        self.assertIn("failWheel", txt)
        self.assertIn("failStage", txt)

    def test_drive_test_surfaces_bridge_reason(self):
        p = REPO_ROOT / "js" / "chrono_wasm_drive_test.js"
        txt = p.read_text(encoding="utf-8")
        self.assertIn("spindleFailStageLabel", txt)
        self.assertIn("wheelIdxLabel", txt)
        self.assertIn("bridge spindle:", txt)
        self.assertIn("failWheel=", txt)
        self.assertIn("failStage=", txt)

    def test_status_assert_guards_raw_spindle_health(self):
        p = REPO_ROOT / "tools" / "chrono_wasm_status_assert.py"
        txt = p.read_text(encoding="utf-8")
        self.assertIn("raw spindle:", txt)
        self.assertIn("bridge(?: spindle)?", txt)
        self.assertIn("bridge spindle reason is", txt)
        self.assertIn("bridge spindle first failure: wheel=", txt)
        self.assertIn("bridge spindle masks out of range", txt)
        self.assertIn("no valid wheels in direct or fallback paths", txt)

    def test_exporter_supports_hardpoint_modes(self):
        p = REPO_ROOT / "tools" / "assetto_corsa_export.py"
        txt = p.read_text(encoding="utf-8")
        self.assertIn("AC_CHRONO_HARDPOINTS_MODE", txt)
        self.assertIn("hardpointsMode", txt)
        self.assertIn("hardpointsRequested", txt)


if __name__ == "__main__":
    unittest.main()
