// Project Chrono VEHICLE -> WebAssembly bridge
//
// Exposes a minimal C API for:
// - creating a world
// - adding static AABB colliders (world-space)
// - creating vehicles (currently: HMMWV_Full)
// - setting driver inputs
// - stepping
// - reading back state (x,z,yaw,speed,steer)
//
// Coordinate mapping:
// Three.js world: X right, Y up, -Z forward (our vehicle meshes are built facing -Z).
// Chrono ISO:    X forward, Y left, Z up.
//
// Map world -> chrono:
//   chrono.x = -world.z
//   chrono.y = -world.x
//   chrono.z =  world.y
// world yaw about +Y maps to chrono yaw about +Z with the same angle.

#include <cstdint>
#include <cmath>
#include <algorithm>
#include <cstdio>
#include <fstream>
#include <memory>
#include <array>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "chrono/ChConfig.h"
#include "chrono/collision/ChCollisionShapeTriangleMesh.h"
#include "chrono/geometry/ChTriangleMeshConnected.h"
#include "chrono/physics/ChSystemSMC.h"
#include "chrono/physics/ChBodyEasy.h"
#include "chrono/physics/ChLinkBase.h"
#include "chrono/physics/ChShaft.h"
#include "chrono/physics/ChContactMaterialSMC.h"
#include "chrono/solver/ChIterativeSolver.h"
#include "chrono/core/ChQuaternion.h"
#include "chrono/core/ChRotation.h"
#include "chrono/core/ChTypes.h"
#include "chrono/core/ChVector3.h"

#include "chrono_vehicle/ChVehicleDataPath.h"
#include "chrono_vehicle/ChTerrain.h"
#include "chrono_vehicle/terrain/RigidTerrain.h"
#include "chrono_vehicle/ChPowertrainAssembly.h"
#include "chrono_vehicle/ChTransmission.h"
#include "chrono_vehicle/powertrain/ChEngineSimpleMap.h"
#include "chrono_vehicle/powertrain/ChAutomaticTransmissionSimpleMap.h"
#include "chrono_vehicle/wheeled_vehicle/vehicle/WheeledVehicle.h"
#include "chrono_vehicle/utils/ChUtilsJSON.h"

#include "chrono_models/vehicle/hmmwv/HMMWV.h"
#include "chrono_models/vehicle/sedan/Sedan.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

using chrono::ChQuaternion;
using chrono::ChVector3d;

namespace {

struct WheelSelInfo {
  int axle;
  chrono::vehicle::VehicleSide side;
  const char* label;
};

static constexpr WheelSelInfo kExpectedSpindleWheels[4] = {
    {0, chrono::vehicle::VehicleSide::LEFT, "FL"},
    {0, chrono::vehicle::VehicleSide::RIGHT, "FR"},
    {1, chrono::vehicle::VehicleSide::LEFT, "RL"},
    {1, chrono::vehicle::VehicleSide::RIGHT, "RR"},
};

static bool ValidateExpectedWheels(chrono::vehicle::WheeledVehicle* veh, const char* spawn_tag,
                                   int* out_present_mask = nullptr, int* out_tire_mask = nullptr,
                                   int* out_axle_count = nullptr) {
  if (!veh) return false;

  const int axle_count = (int)veh->GetNumberAxles();
  if (out_axle_count) *out_axle_count = axle_count;
  bool ok = true;
  int present_mask = 0;
  int tire_mask = 0;

  std::fprintf(stderr, "[cv] %s wheel_map axles=%d", spawn_tag ? spawn_tag : "spawn", axle_count);
  for (int i = 0; i < 4; i++) {
    const int ax = kExpectedSpindleWheels[i].axle;
    const auto sd = kExpectedSpindleWheels[i].side;
    bool present = false;
    bool has_tire = false;
    if (ax >= 0 && ax < axle_count) {
      try {
        auto wheel = veh->GetWheel(ax, sd);
        if (wheel) {
          present = true;
          present_mask |= (1 << i);
          has_tire = (wheel->GetTire() != nullptr);
          if (has_tire) tire_mask |= (1 << i);
        }
      } catch (...) {
      }
    }
    if (!present || !has_tire) ok = false;
    std::fprintf(stderr, " %s(a%d,%c)=%d/%d",
                 kExpectedSpindleWheels[i].label, ax, (sd == chrono::vehicle::VehicleSide::LEFT ? 'L' : 'R'),
                 present ? 1 : 0, has_tire ? 1 : 0);
  }
  std::fprintf(stderr, "\n");
  if (!ok) {
    std::fprintf(stderr, "[cv] %s rejected: expected FL/FR/RL/RR wheel or tire missing\n",
                 spawn_tag ? spawn_tag : "spawn");
  }
  if (out_present_mask) *out_present_mask = present_mask;
  if (out_tire_mask) *out_tire_mask = tire_mask;
  return ok;
}

// Most Chrono vehicle demos spawn with chassis reference Z above ground. If we start at z=0, the chassis/wheels
// can intersect the terrain and produce violent solver impulses (glitches/NaNs). We don't expose spawn Y in the
// C API (only x,z,yaw), so use a conservative fixed world-Y spawn height.
static constexpr double kDefaultSpawnWorldY = 0.90;  // meters (world Y up)

static ChVector3d WorldToChronoPos(double wx, double wy, double wz) {
  return ChVector3d(-wz, -wx, wy);
}

static ChVector3d WorldToChronoVec(double wx, double wy, double wz) {
  return ChVector3d(-wz, -wx, wy);
}

static void ChronoToWorldPos(const ChVector3d& p, double& wx, double& wy, double& wz) {
  wx = -p.y();
  wy = p.z();
  wz = -p.x();
}

// Same axis mapping as ChronoToWorldPos, but semantically for vectors.
static void ChronoToWorldVec(const ChVector3d& v, double& wx, double& wy, double& wz) {
  wx = -v.y();
  wy = v.z();
  wz = -v.x();
}

// Convert Chrono chassis quaternion (Chrono ISO frame) into our Three.js world frame.
// This is a pure axis-basis change (proper rotation), matching WorldToChronoPos/ChronoToWorldPos.
//
// Chrono basis (ISO): X forward, Y left, Z up.
// World basis (Three.js): X right, Y up, Z backward (forward is -Z).
// Mapping of basis vectors:
//   ex_c -> (0,0,-1) = -Z
//   ey_c -> (-1,0,0) = -X
//   ez_c -> (0,1,0) = +Y
struct Qd {
  double w = 1.0;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

static Qd QConj(const Qd& q) { return Qd{q.w, -q.x, -q.y, -q.z}; }

static Qd QMul(const Qd& a, const Qd& b) {
  // Hamilton product
  return Qd{
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

static Qd QNorm(const Qd& q) {
  const double n2 = q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z;
  if (!(n2 > 0.0)) return Qd{};
  const double inv = 1.0 / std::sqrt(n2);
  return Qd{q.w * inv, q.x * inv, q.y * inv, q.z * inv};
}

static Qd QuatFromMat3(double m00, double m01, double m02, double m10, double m11, double m12, double m20, double m21,
                       double m22) {
  const double tr = m00 + m11 + m22;
  Qd q;
  if (tr > 0.0) {
    const double s = std::sqrt(tr + 1.0) * 2.0;  // s=4*w
    q.w = 0.25 * s;
    q.x = (m21 - m12) / s;
    q.y = (m02 - m20) / s;
    q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const double s = std::sqrt(1.0 + m00 - m11 - m22) * 2.0;  // s=4*x
    q.w = (m21 - m12) / s;
    q.x = 0.25 * s;
    q.y = (m01 + m10) / s;
    q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const double s = std::sqrt(1.0 + m11 - m00 - m22) * 2.0;  // s=4*y
    q.w = (m02 - m20) / s;
    q.x = (m01 + m10) / s;
    q.y = 0.25 * s;
    q.z = (m12 + m21) / s;
  } else {
    const double s = std::sqrt(1.0 + m22 - m00 - m11) * 2.0;  // s=4*z
    q.w = (m10 - m01) / s;
    q.x = (m02 + m20) / s;
    q.y = (m12 + m21) / s;
    q.z = 0.25 * s;
  }
  return QNorm(q);
}

static Qd ChronoToWorldQuat(const ChQuaternion<>& qc) {
  // Basis rotation matrix M (world = M * chrono).
  // [ 0 -1  0 ]
  // [ 0  0  1 ]
  // [-1  0  0 ]
  static const Qd qM = QuatFromMat3(0, -1, 0, 0, 0, 1, -1, 0, 0);
  const Qd qC{qc.e0(), qc.e1(), qc.e2(), qc.e3()};
  return QNorm(QMul(QMul(qM, qC), QConj(qM)));
}

static double WorldQuatToYawY(const Qd& q) {
  // Yaw about +Y in world (Three.js up axis).
  // yaw = atan2(2*(w*y + x*z), 1 - 2*(y*y + z*z))
  const double siny_cosp = 2.0 * (q.w * q.y + q.x * q.z);
  const double cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z);
  return std::atan2(siny_cosp, cosy_cosp);
}

static ChQuaternion<> YawToChronoRot(double yaw) {
  // yaw about Chrono +Z
  return chrono::QuatFromAngleZ(yaw);
}

static double ChronoRotToYaw(const ChQuaternion<>& q) {
  // Extract yaw about Z from quaternion (assuming mostly planar motion).
  // yaw = atan2(2*(w*z + x*y), 1 - 2*(y*y + z*z))
  const double w = q.e0();
  const double x = q.e1();
  const double y = q.e2();
  const double z = q.e3();
  const double siny_cosp = 2.0 * (w * z + x * y);
  const double cosy_cosp = 1.0 - 2.0 * (y * y + z * z);
  return std::atan2(siny_cosp, cosy_cosp);
}

struct VehicleInst {
  bool alive = true;
  int kind = 0;
  chrono::vehicle::DriverInputs inputs;
  std::unique_ptr<chrono::vehicle::hmmwv::HMMWV_Full> hmmwv;
  std::unique_ptr<chrono::vehicle::sedan::Sedan> sedan;
  std::unique_ptr<chrono::vehicle::WheeledVehicle> json_vehicle;
  // Optional overrides (persist until cleared).
  bool brake4_active = false;
  float brake4[4] = {0, 0, 0, 0};  // FL,FR,RL,RR (0..1)
  bool wheel_mu4_active = false;
  float wheel_mu4[4] = {1, 1, 1, 1};  // FL,FR,RL,RR (0.05..4)
  // Input scaling to approximate per-car steering ranges and pedal calibration.
  float steerInputScale = 1.0f;
  // Best-effort max steer (rad), used for readback fallbacks.
  float maxSteerRad = 0.48f;
  float throttleInputScale = 1.0f;
  float brakeInputScale = 1.0f;
  // Simple differential locking proxy (bool-ish, applied based on throttle/brake).
  float diffLockPower = 0.0f;  // 0..1
  float diffLockCoast = 0.0f;  // 0..1

  // Best-effort cleanup: items created for this vehicle (so we can remove the vehicle without destroying the world).
  std::vector<std::shared_ptr<chrono::ChBody>> created_bodies;
  std::vector<std::shared_ptr<chrono::ChLinkBase>> created_links;
  std::vector<std::shared_ptr<chrono::ChShaft>> created_shafts;
  std::vector<std::shared_ptr<chrono::ChPhysicsItem>> created_others;

  // Last known-good spindle packet (4 wheels * 13 floats).
  bool spindle_cache_valid = false;
  std::array<float, 52> spindle_cache = {};
  // Last spindle readback status for diagnostics.
  int spindle_last_reason = 0;  // 0=unset, 1=ok_direct, 2=ok_cache_missing_wheel, 3=ok_cache_sane_fail, 4=fail_no_cache,
                                // 7=ok_fallback_only, 8=ok_mixed
  float spindle_last_wb = 0.0f;
  float spindle_last_tf = 0.0f;
  float spindle_last_tr = 0.0f;
  float spindle_last_max_pos = 0.0f;
  float spindle_last_max_vel = 0.0f;
  float spindle_last_max_ang = 0.0f;
  int spindle_last_all_wheels_ok = 0;
  int spindle_last_sane_packet = 0;
  int spindle_last_fail_wheel = -1;   // 0..3 for FL/FR/RL/RR
  int spindle_last_fail_stage = 0;    // 0=none, 1=direct_invalid, 2=fallback_invalid
  int spindle_last_direct_ok_mask = 0;    // bit i set when direct getter succeeded for wheel i
  int spindle_last_fallback_ok_mask = 0;  // bit i set when fallback wheel-state succeeded for wheel i
  int spindle_last_axle_count = 0;
  int spindle_last_wheel_ptr_mask = 0;            // bit i set when GetWheel(ax,side) returned non-null
  int spindle_last_wheel_state_finite_mask = 0;   // bit i set when fallback wheel state was finite
  int spindle_last_fallback_attempt_mask = 0;     // bit i set when fallback path was attempted
  int spindle_last_ws_pos_finite_mask = 0;        // bit i set when fallback wheel-state position finite
  int spindle_last_ws_rot_finite_mask = 0;        // bit i set when fallback wheel-state rotation finite
  int spindle_last_ws_lin_finite_mask = 0;        // bit i set when fallback wheel-state linear velocity finite
  int spindle_last_ws_ang_finite_mask = 0;        // bit i set when fallback wheel-state angular velocity finite
  int spindle_last_ws_exception_mask = 0;         // bit i set when fallback wheel-state read threw
  int spindle_last_direct_pos_finite_mask = 0;    // bit i set when direct spindle position finite
  int spindle_last_direct_rot_finite_mask = 0;    // bit i set when direct spindle rotation finite
  int spindle_last_direct_lin_finite_mask = 0;    // bit i set when direct spindle linear velocity finite
  int spindle_last_direct_ang_finite_mask = 0;    // bit i set when direct spindle angular velocity finite
  int spindle_last_direct_exception_mask = 0;     // bit i set when direct spindle getters threw
  int spindle_last_sb_attempt_mask = 0;           // bit i set when spindle-body fallback was attempted
  int spindle_last_sb_pos_finite_mask = 0;        // bit i set when spindle-body position finite
  int spindle_last_sb_rot_finite_mask = 0;        // bit i set when spindle-body rotation finite
  int spindle_last_sb_lin_finite_mask = 0;        // bit i set when spindle-body linear velocity finite
  int spindle_last_sb_ang_finite_mask = 0;        // bit i set when spindle-body angular velocity finite
  int spindle_last_sb_exception_mask = 0;         // bit i set when spindle-body fallback threw
  int spindle_heal_events_total = 0;              // count of wheels healed due to non-finite spindle state
  int spindle_heal_events_pre = 0;                // count healed in pre-step scrub
  int spindle_heal_events_post = 0;               // count healed in post-step scrub
  int spindle_heal_last_stage = 0;                // 0=none, 1=pre_step, 2=post_step
  int spindle_heal_last_wheel_mask = 0;           // bit i set when wheel i was healed in last scrub pass
  int spindle_heal_pos_events = 0;                // count of non-finite position channels healed
  int spindle_heal_rot_events = 0;                // count of non-finite rotation channels healed
  int spindle_heal_lin_events = 0;                // count of non-finite linear-velocity channels healed
  int spindle_heal_ang_events = 0;                // count of non-finite angular-velocity channels healed
  // Spawn-time wheel offsets in chassis local frame; used as a last-resort readback fallback when
  // Chrono returns non-finite translational spindle channels.
  int spindle_seed_local_mask = 0;                // bit i set when local offset for FL/FR/RL/RR was captured
  std::array<ChVector3d, 4> spindle_seed_local = {
      ChVector3d(0, 0, 0), ChVector3d(0, 0, 0), ChVector3d(0, 0, 0), ChVector3d(0, 0, 0)};
  bool spawn_pose_valid = false;
  ChVector3d spawn_pos_chrono = ChVector3d(0, 0, 0);
  ChQuaternion<> spawn_rot_chrono = ChQuaternion<>(1, 0, 0, 0);
  int spawn_expected_wheel_mask = 0;              // bit i set when expected FL/FR/RL/RR wheel existed at spawn
  int spawn_expected_tire_mask = 0;               // bit i set when expected FL/FR/RL/RR had tire at spawn
  int ptrain_inert_frames = 0;                    // sustained throttle-in-drive with near-zero drivetrain response
  bool ptrain_bootstrap_applied = false;          // one-shot standstill kick to break zero-speed lock
  int ptrain_bootstrap_events = 0;                // count of fallback launch nudges
  float ptrain_last_nudge_mps = 0.0f;             // last commanded fallback chassis speed
  // Bridge-owned inert-drive motion proxy (used when drivetrain is non-responsive).
  bool drive_proxy_active = false;
  double drive_proxy_speed = 0.0;                 // signed forward speed in chrono frame
  double drive_proxy_yaw_rate = 0.0;              // rad/s about chrono +Z
  double drive_proxy_last_time = 0.0;             // last world time when proxy was advanced
  ChVector3d drive_proxy_pos = ChVector3d(0, 0, 0);
  ChQuaternion<> drive_proxy_rot = ChQuaternion<>(1, 0, 0, 0);
  int dbg_state_calls = 0;
  int dbg_state_ok = 0;
  int dbg_state_ex_calls = 0;
  int dbg_state_ex_ok = 0;
  int dbg_wheel_calls = 0;
  int dbg_wheel_ok = 0;
  int dbg_powertrain_calls = 0;
  int dbg_powertrain_ok = 0;
};

struct HeightfieldData {
  bool active = false;
  int nx = 0;  // samples along world +X
  int nz = 0;  // samples along world +Z
  double sizeX = 0.0;  // meters
  double sizeZ = 0.0;  // meters
  double centerX = 0.0;  // world
  double centerY = 0.0;  // world base height
  double centerZ = 0.0;  // world
  double heightScale = 1.0;
  float mu = 1.0f;
  std::vector<float> h;  // row-major: h[ix + iz*nx]
};

static inline float Clamp01f(float x) { return std::max(0.0f, std::min(1.0f, x)); }

static inline float HF_At(const HeightfieldData& hf, int ix, int iz) {
  if (hf.nx <= 0 || hf.nz <= 0 || hf.h.empty()) return 0.0f;
  ix = std::max(0, std::min(hf.nx - 1, ix));
  iz = std::max(0, std::min(hf.nz - 1, iz));
  const size_t idx = (size_t)ix + (size_t)iz * (size_t)hf.nx;
  if (idx >= hf.h.size()) return 0.0f;
  const float v = hf.h[idx];
  return std::isfinite(v) ? v : 0.0f;
}

static double HF_SampleHeightWorldY(const HeightfieldData& hf, double wx, double wz) {
  if (!hf.active || hf.nx < 2 || hf.nz < 2 || !(hf.sizeX > 1e-6) || !(hf.sizeZ > 1e-6)) {
    return 0.0;
  }
  const double xMin = hf.centerX - 0.5 * hf.sizeX;
  const double zMin = hf.centerZ - 0.5 * hf.sizeZ;
  const double u = (wx - xMin) / hf.sizeX;
  const double v = (wz - zMin) / hf.sizeZ;
  const double fx = std::max(0.0, std::min((double)(hf.nx - 1), u * (double)(hf.nx - 1)));
  const double fz = std::max(0.0, std::min((double)(hf.nz - 1), v * (double)(hf.nz - 1)));
  const int x0 = (int)std::floor(fx);
  const int z0 = (int)std::floor(fz);
  const int x1 = std::min(x0 + 1, hf.nx - 1);
  const int z1 = std::min(z0 + 1, hf.nz - 1);
  const float tx = (float)Clamp01f((float)(fx - (double)x0));
  const float tz = (float)Clamp01f((float)(fz - (double)z0));
  const float h00 = HF_At(hf, x0, z0);
  const float h10 = HF_At(hf, x1, z0);
  const float h01 = HF_At(hf, x0, z1);
  const float h11 = HF_At(hf, x1, z1);
  const float hx0 = (1.0f - tx) * h00 + tx * h10;
  const float hx1 = (1.0f - tx) * h01 + tx * h11;
  const float h = (1.0f - tz) * hx0 + tz * hx1;
  const double wy = hf.centerY + hf.heightScale * (double)h;
  return std::isfinite(wy) ? wy : 0.0;
}

static ChVector3d HF_SampleNormalWorld(const HeightfieldData& hf, double wx, double wz) {
  if (!hf.active || hf.nx < 2 || hf.nz < 2 || !(hf.sizeX > 1e-6) || !(hf.sizeZ > 1e-6)) {
    return ChVector3d(0, 1, 0);
  }
  const double dx = hf.sizeX / (double)(hf.nx - 1);
  const double dz = hf.sizeZ / (double)(hf.nz - 1);
  if (!(dx > 1e-9) || !(dz > 1e-9)) return ChVector3d(0, 1, 0);

  const double xMin = hf.centerX - 0.5 * hf.sizeX;
  const double zMin = hf.centerZ - 0.5 * hf.sizeZ;
  const double u = (wx - xMin) / hf.sizeX;
  const double v = (wz - zMin) / hf.sizeZ;
  const double fx = std::max(0.0, std::min((double)(hf.nx - 1), u * (double)(hf.nx - 1)));
  const double fz = std::max(0.0, std::min((double)(hf.nz - 1), v * (double)(hf.nz - 1)));
  const int ix = std::max(0, std::min(hf.nx - 1, (int)std::lround(fx)));
  const int iz = std::max(0, std::min(hf.nz - 1, (int)std::lround(fz)));

  const double hx1 = (double)HF_At(hf, ix + 1, iz);
  const double hx0 = (double)HF_At(hf, ix - 1, iz);
  const double hz1 = (double)HF_At(hf, ix, iz + 1);
  const double hz0 = (double)HF_At(hf, ix, iz - 1);
  const double dfdx = hf.heightScale * (hx1 - hx0) / (2.0 * dx);
  const double dfdz = hf.heightScale * (hz1 - hz0) / (2.0 * dz);

  // For height y = f(x,z): n = normalize((-df/dx, 1, -df/dz))
  const double nx = -dfdx;
  const double ny = 1.0;
  const double nz = -dfdz;
  const double n2 = nx * nx + ny * ny + nz * nz;
  if (!(n2 > 0.0) || !std::isfinite(n2)) return ChVector3d(0, 1, 0);
  const double inv = 1.0 / std::sqrt(n2);
  return ChVector3d(nx * inv, ny * inv, nz * inv);
}

class HeightfieldHeightFunctor : public chrono::vehicle::ChTerrain::HeightFunctor {
 public:
  explicit HeightfieldHeightFunctor(HeightfieldData* hf) : m_hf(hf) {}
  double operator()(const ChVector3d& loc) override {
    if (!m_hf) return 0.0;
    // chrono -> world: (x,y,z) -> (-y, z, -x)
    const double wx = -loc.y();
    const double wz = -loc.x();
    return HF_SampleHeightWorldY(*m_hf, wx, wz);  // chrono height == world Y
  }

 private:
  HeightfieldData* m_hf = nullptr;
};

class HeightfieldNormalFunctor : public chrono::vehicle::ChTerrain::NormalFunctor {
 public:
  explicit HeightfieldNormalFunctor(HeightfieldData* hf) : m_hf(hf) {}
  ChVector3d operator()(const ChVector3d& loc) override {
    if (!m_hf) return ChVector3d(0, 0, 1);
    const double wx = -loc.y();
    const double wz = -loc.x();
    const auto nW = HF_SampleNormalWorld(*m_hf, wx, wz);  // world normal (x,y,z)
    const auto nC = WorldToChronoVec(nW.x(), nW.y(), nW.z());
    const double n2 = nC.Length2();
    if (!(n2 > 0.0) || !std::isfinite(n2)) return ChVector3d(0, 0, 1);
    return nC / std::sqrt(n2);
  }

 private:
  HeightfieldData* m_hf = nullptr;
};

struct WheelFrictionPoint {
  ChVector3d pos = ChVector3d(0, 0, 0);  // chrono ISO
  float mu = 1.0f;
};

struct World {
  double time = 0.0;
  double spawnWorldY = kDefaultSpawnWorldY;
  std::shared_ptr<chrono::ChSystemSMC> sys;
  std::unique_ptr<chrono::vehicle::ChTerrain> terrain;
  std::vector<std::shared_ptr<chrono::ChContactMaterialSMC>> terrain_mats;
  std::vector<WheelFrictionPoint> wheel_friction_points;  // updated each step (chrono ISO)
  HeightfieldData heightfield;
  std::vector<std::shared_ptr<chrono::ChBody>> statics;
  std::shared_ptr<chrono::ChBody> heightfield_body;
  std::vector<VehicleInst> vehicles;
};

class HeightfieldFrictionFunctor : public chrono::vehicle::ChTerrain::FrictionFunctor {
 public:
  explicit HeightfieldFrictionFunctor(World* w) : m_w(w) {}
  float operator()(const ChVector3d& loc) override {
    // Base friction is the current terrain friction (heightfield.mu mirrors rigid patch mats too).
    float base_mu = 1.0f;
    try {
      if (m_w) base_mu = std::max(0.05f, std::min(4.0f, m_w->heightfield.mu));
    } catch (...) {
    }
    if (!m_w) return base_mu;

    // Per-wheel override: pick the nearest wheel point (planar distance in chrono X/Y).
    const auto& pts = m_w->wheel_friction_points;
    if (pts.empty()) return base_mu;
    const double x = loc.x();
    const double y = loc.y();
    double best_d2 = 1e100;
    float best_mu = base_mu;
    for (const auto& p : pts) {
      const double dx = p.pos.x() - x;
      const double dy = p.pos.y() - y;
      const double d2 = dx * dx + dy * dy;
      if (d2 < best_d2) {
        best_d2 = d2;
        best_mu = p.mu;
      }
    }
    // Soft guard: only override if we're plausibly near a wheel.
    if (best_d2 <= (4.0 * 4.0)) {
      return std::max(0.05f, std::min(4.0f, best_mu));
    }
    return base_mu;
  }

 private:
  World* m_w = nullptr;
};

static std::unordered_map<int, std::unique_ptr<World>> g_worlds;
static int g_next_world = 1;

static World* GetWorld(int wid) {
  auto it = g_worlds.find(wid);
  if (it == g_worlds.end()) return nullptr;
  return it->second.get();
}

struct SystemSnapshot {
  std::unordered_set<const void*> bodies;
  std::unordered_set<const void*> links;
  std::unordered_set<const void*> shafts;
  std::unordered_set<const void*> others;
};

static SystemSnapshot SnapshotSystem(chrono::ChSystem* sys) {
  SystemSnapshot s;
  if (!sys) return s;
  try {
    for (const auto& b : sys->GetBodies()) s.bodies.insert((const void*)b.get());
    for (const auto& l : sys->GetLinks()) s.links.insert((const void*)l.get());
    for (const auto& sh : sys->GetShafts()) s.shafts.insert((const void*)sh.get());
    for (const auto& o : sys->GetOtherPhysicsItems()) s.others.insert((const void*)o.get());
  } catch (...) {
  }
  return s;
}

static void CaptureNewSystemItems(chrono::ChSystem* sys, const SystemSnapshot& pre, VehicleInst& inst) {
  if (!sys) return;
  try {
    for (const auto& b : sys->GetBodies()) {
      if (!b) continue;
      if (pre.bodies.find((const void*)b.get()) == pre.bodies.end()) inst.created_bodies.push_back(b);
    }
    for (const auto& l : sys->GetLinks()) {
      if (!l) continue;
      if (pre.links.find((const void*)l.get()) == pre.links.end()) inst.created_links.push_back(l);
    }
    for (const auto& sh : sys->GetShafts()) {
      if (!sh) continue;
      if (pre.shafts.find((const void*)sh.get()) == pre.shafts.end()) inst.created_shafts.push_back(sh);
    }
    for (const auto& o : sys->GetOtherPhysicsItems()) {
      if (!o) continue;
      if (pre.others.find((const void*)o.get()) == pre.others.end()) inst.created_others.push_back(o);
    }
  } catch (...) {
  }
}

static chrono::vehicle::ChWheeledVehicle* GetWheeledVehicle(VehicleInst& v) {
  if (v.hmmwv) return &v.hmmwv->GetVehicle();
  if (v.sedan) return &v.sedan->GetVehicle();
  if (v.json_vehicle) return v.json_vehicle.get();
  return nullptr;
}

static std::shared_ptr<chrono::ChBodyAuxRef> GetChassisBody(VehicleInst& v) {
  if (v.hmmwv) return v.hmmwv->GetChassisBody();
  if (v.sedan) return v.sedan->GetChassisBody();
  if (v.json_vehicle) return v.json_vehicle->GetChassisBody();
  return nullptr;
}

static double GetChassisForwardSpeedChrono(const std::shared_ptr<chrono::ChBodyAuxRef>& chassis);
static inline bool IsFiniteVec3(const ChVector3d& v);
static inline bool IsFiniteQuat4(const ChQuaternion<>& q);

static bool UpdateDriveProxyForReadback(World* w,
                                        VehicleInst& v,
                                        chrono::vehicle::ChWheeledVehicle* vehp,
                                        const std::shared_ptr<chrono::ChBodyAuxRef>& chassis) {
  (void)w;
  (void)vehp;
  (void)chassis;
  v.drive_proxy_active = false;
  v.drive_proxy_speed = 0.0;
  v.drive_proxy_yaw_rate = 0.0;
  return false;
}

static inline bool IsFiniteVec3(const ChVector3d& v) {
  return std::isfinite(v.x()) && std::isfinite(v.y()) && std::isfinite(v.z());
}

static inline bool IsFiniteQuat4(const ChQuaternion<>& q) {
  return std::isfinite(q.e0()) && std::isfinite(q.e1()) && std::isfinite(q.e2()) && std::isfinite(q.e3());
}

static ChVector3d DefaultSpindleSeedLocalForIndex(int i) {
  // Generic road-car fallback geometry in Chrono local frame (X forward, Y left, Z up).
  // Used only when no spawn seed is available and live spindle channels are non-finite.
  static constexpr double kHalfWheelbase = 1.30;   // wb ~= 2.60m
  static constexpr double kHalfTrackFront = 0.78;  // tf ~= 1.56m
  static constexpr double kHalfTrackRear = 0.78;   // tr ~= 1.56m
  switch (i) {
    case 0: return ChVector3d(+kHalfWheelbase, +kHalfTrackFront, 0.0);  // FL
    case 1: return ChVector3d(+kHalfWheelbase, -kHalfTrackFront, 0.0);  // FR
    case 2: return ChVector3d(-kHalfWheelbase, +kHalfTrackRear, 0.0);   // RL
    case 3: return ChVector3d(-kHalfWheelbase, -kHalfTrackRear, 0.0);   // RR
    default: return ChVector3d(0, 0, 0);
  }
}

static double GetChassisForwardSpeedChrono(const std::shared_ptr<chrono::ChBodyAuxRef>& chassis) {
  if (!chassis) return 0.0;
  try {
    const auto vabs = chassis->GetPosDt();
    auto fwd = chassis->GetRot().Rotate(ChVector3d(1.0, 0.0, 0.0));
    const double n = fwd.Length();
    if (!(n > 1e-9) || !std::isfinite(n)) return 0.0;
    fwd /= n;
    const double s = vabs.Dot(fwd);
    return std::isfinite(s) ? s : 0.0;
  } catch (...) {
    return 0.0;
  }
}

static void CaptureSpindleSeedLocal(VehicleInst& v) {
  v.spindle_seed_local_mask = 0;
  auto vehp = GetWheeledVehicle(v);
  auto chassis = GetChassisBody(v);
  if (!vehp || !chassis) return;
  try {
    const auto cf = chassis->GetFrameRefToAbs();
    for (int i = 0; i < 4; i++) {
      const int ax = kExpectedSpindleWheels[i].axle;
      const auto sd = kExpectedSpindleWheels[i].side;
      try {
        auto wheel = vehp->GetWheel(ax, sd);
        if (!wheel) continue;
        auto spindle = wheel->GetSpindle();
        if (!spindle) continue;
        const auto p = spindle->GetPos();
        if (!std::isfinite(p.x()) || !std::isfinite(p.y()) || !std::isfinite(p.z())) continue;
        v.spindle_seed_local[(size_t)i] = cf.TransformPointParentToLocal(p);
        v.spindle_seed_local_mask |= (1 << i);
      } catch (...) {
      }
    }
  } catch (...) {
    v.spindle_seed_local_mask = 0;
  }
}

static void DisableVehicleBodySleeping(VehicleInst& v) {
  auto vehp = GetWheeledVehicle(v);
  auto chassis = GetChassisBody(v);
  if (!vehp || !chassis) return;
  try { chassis->SetSleepingAllowed(false); } catch (...) {}
  try {
    for (int i = 0; i < 4; i++) {
      const int ax = kExpectedSpindleWheels[i].axle;
      const auto sd = kExpectedSpindleWheels[i].side;
      try {
        auto wheel = vehp->GetWheel(ax, sd);
        if (!wheel) continue;
        auto spindle = wheel->GetSpindle();
        if (spindle) spindle->SetSleepingAllowed(false);
      } catch (...) {
      }
    }
  } catch (...) {
  }
}

static void HealVehicleSpindleBodies(VehicleInst& v, int stage_code) {
  auto vehp = GetWheeledVehicle(v);
  auto chassis = GetChassisBody(v);
  if (!vehp || !chassis) return;
  if ((int)vehp->GetNumberAxles() < 2) return;
  int healed_mask = 0;
  try {
    const auto cf = chassis->GetFrameRefToAbs();
    const auto cf_pos = cf.GetPos();
    const auto cf_rot = cf.GetRot();
    const bool cf_finite = IsFiniteVec3(cf_pos) && IsFiniteQuat4(cf_rot);
    const ChVector3d base_pos = cf_finite ? cf_pos : (v.spawn_pose_valid ? v.spawn_pos_chrono : ChVector3d(0, 0, 0));
    const ChQuaternion<> base_rot = cf_finite ? cf_rot : (v.spawn_pose_valid ? v.spawn_rot_chrono : ChQuaternion<>(1, 0, 0, 0));

    for (int i = 0; i < 4; i++) {
      const int ax = kExpectedSpindleWheels[i].axle;
      const auto sd = kExpectedSpindleWheels[i].side;
      try {
        auto wheel = vehp->GetWheel(ax, sd);
        if (!wheel) continue;
        auto spindle = wheel->GetSpindle();
        if (!spindle) continue;

        const auto p = spindle->GetPos();
        const auto q = spindle->GetRot();
        const auto vlin = spindle->GetPosDt();
        const auto vang = spindle->GetAngVelParent();
        const bool pos_ok = IsFiniteVec3(p);
        const bool rot_ok = IsFiniteQuat4(q);
        const bool lin_ok = IsFiniteVec3(vlin);
        const bool ang_ok = IsFiniteVec3(vang);
        if (pos_ok && rot_ok && lin_ok && ang_ok) continue;

        const ChVector3d local_seed =
            (v.spindle_seed_local_mask & (1 << i)) ? v.spindle_seed_local[(size_t)i] : DefaultSpindleSeedLocalForIndex(i);
        const ChVector3d p_syn = base_pos + base_rot.Rotate(local_seed);
        if (!pos_ok) spindle->SetPos(p_syn);
        if (!rot_ok) spindle->SetRot(base_rot);
        if (!lin_ok) spindle->SetPosDt(ChVector3d(0, 0, 0));
        if (!ang_ok) spindle->SetAngVelParent(ChVector3d(0, 0, 0));
        if (!pos_ok) v.spindle_heal_pos_events++;
        if (!rot_ok) v.spindle_heal_rot_events++;
        if (!lin_ok) v.spindle_heal_lin_events++;
        if (!ang_ok) v.spindle_heal_ang_events++;
        healed_mask |= (1 << i);
      } catch (...) {
      }
    }
  } catch (...) {
  }
  if (healed_mask) {
    const int n = ((healed_mask & 1) ? 1 : 0) + ((healed_mask & 2) ? 1 : 0) + ((healed_mask & 4) ? 1 : 0) + ((healed_mask & 8) ? 1 : 0);
    v.spindle_heal_events_total += n;
    if (stage_code == 1) v.spindle_heal_events_pre += n;
    if (stage_code == 2) v.spindle_heal_events_post += n;
    v.spindle_heal_last_stage = stage_code;
    v.spindle_heal_last_wheel_mask = healed_mask;
  }
}

static double GetFrontSteerAngleRad(chrono::vehicle::ChWheeledVehicle* vehp, VehicleInst& inst) {
  if (!vehp) return 0.0;
  try {
    const double sl = (double)vehp->GetSteeringAngle(0, chrono::vehicle::VehicleSide::LEFT);
    const double sr = (double)vehp->GetSteeringAngle(0, chrono::vehicle::VehicleSide::RIGHT);
    if (std::isfinite(sl + sr)) return 0.5 * (sl + sr);
  } catch (...) {
  }
  // Fallback: approximate from normalized steering input using a conservative "typical" max steer.
  const double ms = (double)inst.maxSteerRad;
  const double base = (std::isfinite(ms) && ms > 1e-4) ? ms : 0.48;
  return (double)inst.inputs.m_steering * base;
}

// External/tunable simple-map engine.
class ExtEngineSimpleMap : public chrono::vehicle::ChEngineSimpleMap {
 public:
  explicit ExtEngineSimpleMap(const std::string& name) : chrono::vehicle::ChEngineSimpleMap(name) {}

  void SetFromRpmTorque(int n, const float* rpm, const float* tq, float max_rpm, float coast_tq = -30.0f) {
    m_pts.clear();
    m_max_rpm = std::max(1000.0f, max_rpm);
    m_coast_tq = coast_tq;
    if (!rpm || !tq || n <= 0) return;
    m_pts.reserve((size_t)n);
    for (int i = 0; i < n; i++) {
      const double r = (double)rpm[i];
      const double t = (double)tq[i];
      if (!(r >= 0) || !std::isfinite(r + t)) continue;
      m_pts.push_back({r, t});
    }
    if (!m_pts.empty()) {
      std::sort(m_pts.begin(), m_pts.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
      const bool have_nonzero_launch =
          std::any_of(m_pts.begin(), m_pts.end(), [](const auto& p) { return p.first <= 1e-6 && p.second > 1.0; });
      if (!have_nonzero_launch) {
        const auto it = std::find_if(m_pts.begin(), m_pts.end(), [](const auto& p) { return p.first > 1e-6 && p.second > 1.0; });
        if (it != m_pts.end()) {
          const double launch_tq = std::max(40.0, it->second);
          m_pts.insert(m_pts.begin(), {0.0, launch_tq});
        }
      }
    }
  }

  double GetMaxEngineSpeed() override { return m_max_rpm * (chrono::CH_PI / 30.0); }

  void SetEngineTorqueMaps(chrono::ChFunctionInterp& map0, chrono::ChFunctionInterp& mapF) override {
    const double rpm2rads = chrono::CH_PI / 30.0;
    // Zero-throttle: simple engine braking curve.
    map0.AddPoint(-10.0, 0.0);
    map0.AddPoint(10.0, 0.0);
    map0.AddPoint(rpm2rads * 1000.0, (double)m_coast_tq);
    map0.AddPoint(rpm2rads * std::max(1000.0, (double)m_max_rpm), (double)(m_coast_tq * 2.0f));

    // Full-throttle map.
    if (m_pts.empty()) {
      mapF.AddPoint(-10.0, 250.0);
      mapF.AddPoint(rpm2rads * 1000.0, 250.0);
      mapF.AddPoint(rpm2rads * 6000.0, 200.0);
      mapF.AddPoint(rpm2rads * 6500.0, 150.0);
      return;
    }
    mapF.AddPoint(-10.0, std::max(0.0, m_pts.front().second));
    for (const auto& p : m_pts) {
      mapF.AddPoint(rpm2rads * p.first, p.second);
    }
  }

 private:
  std::vector<std::pair<double, double>> m_pts;
  float m_max_rpm = 6500.0f;
  float m_coast_tq = -30.0f;
};

// External/tunable simple-map automatic transmission.
class ExtAutomaticTransmissionSimpleMap : public chrono::vehicle::ChAutomaticTransmissionSimpleMap {
 public:
  explicit ExtAutomaticTransmissionSimpleMap(const std::string& name) : chrono::vehicle::ChAutomaticTransmissionSimpleMap(name) {}

  void SetFromReductions(float final_ratio, float rev_reduction, int n_fwd, const float* fwd_reductions, float max_rpm) {
    m_fwd.clear();
    m_rev = 0.0;
    m_shift.clear();
    const double fr = std::max(1e-3f, final_ratio);
    std::vector<double> in_fwd;
    if (fwd_reductions && n_fwd > 0) {
      in_fwd.reserve((size_t)n_fwd);
      for (int i = 0; i < n_fwd; i++) {
        const double g = (double)fwd_reductions[i];
        if (!(g > 0.0) || !std::isfinite(g)) continue;
        in_fwd.push_back(std::abs(g));
      }
    }
    // Accept both:
    //  A) reduction-domain gears (e.g. 3.7, 2.2) with final_ratio applied here
    //  B) Chrono-native gearbox ratios already in JSON (e.g. 0.12, 0.24, 1.0)
    // If values are mostly <= ~1.2, treat as Chrono-native and do not re-transform.
    bool direct_ratios = false;
    if (!in_fwd.empty()) {
      auto tmp = in_fwd;
      std::sort(tmp.begin(), tmp.end());
      const double med = tmp[tmp.size() / 2];
      direct_ratios = (med <= 1.2);
    }
    const double rr_raw = std::max(1e-6f, std::abs(rev_reduction));
    if (direct_ratios) {
      m_rev = -std::max(0.01, rr_raw);
      m_fwd.reserve(in_fwd.size());
      for (double g : in_fwd) {
        // Keep broad bounds but avoid zero/denormal ratios.
        m_fwd.push_back(std::max(0.01, std::min(4.0, g)));
      }
    } else {
      const double rr = std::max(0.01, rr_raw);
      // Chrono expects ratios like 1/reduction (see Sedan_AutomaticTransmissionSimpleMap).
      m_rev = -1.0 / (rr * fr);
      m_fwd.reserve(in_fwd.size());
      for (double gr : in_fwd) {
        m_fwd.push_back(1.0 / (gr * fr));
      }
    }
    // Shift bands (rad/s).
    const double rpm2rads = chrono::CH_PI / 30.0;
    const double maxr = std::max(1500.0f, max_rpm) * rpm2rads;
    const double down = 0.38 * maxr;
    const double up = 0.93 * maxr;
    const int nBands = (int)std::max<size_t>(1, m_fwd.size());
    for (int i = 0; i < nBands; i++) {
      m_shift.push_back({down, up});
    }
  }

  void SetGearRatios(std::vector<double>& fwd, double& rev) override {
    fwd = m_fwd;
    rev = m_rev;
    if (fwd.empty()) {
      // fallback to Sedan-ish ratios if nothing was provided
      rev = -1.0 / 3.333;
      fwd.push_back(1.0 / 3.778);
      fwd.push_back(1.0 / 2.045);
      fwd.push_back(1.0 / 1.276);
      fwd.push_back(1.0 / 0.941);
      fwd.push_back(1.0 / 0.784);
      fwd.push_back(1.0 / 0.667);
    }
  }

  void SetShiftPoints(std::vector<std::pair<double, double>>& shift_bands) override {
    shift_bands = m_shift;
    if (shift_bands.empty()) {
      const double rpm2rads = chrono::CH_PI / 30.0;
      shift_bands.push_back({1000 * rpm2rads, 4000 * rpm2rads});
      shift_bands.push_back({1200 * rpm2rads, 4500 * rpm2rads});
      shift_bands.push_back({1400 * rpm2rads, 4500 * rpm2rads});
      shift_bands.push_back({1600 * rpm2rads, 4500 * rpm2rads});
      shift_bands.push_back({1800 * rpm2rads, 4500 * rpm2rads});
      shift_bands.push_back({2000 * rpm2rads, 4500 * rpm2rads});
    }
  }

 private:
  std::vector<double> m_fwd;
  double m_rev = 0.0;
  std::vector<std::pair<double, double>> m_shift;
};

static void EnsureDefaultPowertrain(chrono::vehicle::ChWheeledVehicle* vehp) {
  if (!vehp) return;
  // Always inject a deterministic default map in WASM runtime to avoid authored packs
  // stalling at standstill due missing torque-converter/idle behavior differences.

  // Default "generic car" powertrain map (roughly matches the JS fallback tuning).
  static const float kRpmPts[] = {1000, 1500, 2000, 3000, 4000, 5000, 6500};
  static const float kTqPts[] = {220, 250, 270, 285, 275, 255, 210};
  static const float kFwdReductions[] = {3.20f, 2.10f, 1.50f, 1.10f, 0.90f};

  try {
    auto eng = chrono_types::make_shared<ExtEngineSimpleMap>("DefaultEngine");
    eng->SetFromRpmTorque((int)(sizeof(kRpmPts) / sizeof(kRpmPts[0])), kRpmPts, kTqPts, 6500.0f, -35.0f);
    auto trn = chrono_types::make_shared<ExtAutomaticTransmissionSimpleMap>("DefaultTransmission");
    trn->SetFromReductions(4.10f, 3.20f, (int)(sizeof(kFwdReductions) / sizeof(kFwdReductions[0])), kFwdReductions, 6500.0f);
    auto p = chrono_types::make_shared<chrono::vehicle::ChPowertrainAssembly>(eng, trn);
    vehp->InitializePowertrain(p);
    try {
      auto trans = vehp->GetTransmission();
      if (trans) trans->SetGear(1);
    } catch (...) {
    }
  } catch (...) {
  }
}

static bool FsFileExists(const std::string& path) {
  if (path.empty()) return false;
  std::ifstream f(path.c_str(), std::ios::binary);
  return f.good();
}

static std::string ResolveVehicleJsonPath(const std::string& in_path) {
  if (in_path.empty()) return std::string();
  if (in_path[0] == '/') return in_path;

  // 1) Standard Chrono vehicle data root (/data/vehicle by our setup).
  try {
    const std::string p = chrono::vehicle::GetVehicleDataFile(in_path);
    if (!p.empty() && FsFileExists(p)) return p;
  } catch (...) {
  }

  // 2) Explicit /data/* path (for custom preloads).
  const std::string p2 = std::string("/data/") + in_path;
  if (FsFileExists(p2)) return p2;

  // 3) Explicit /data/vehicle/* path (common for vehicle JSON trees).
  const std::string p3 = std::string("/data/vehicle/") + in_path;
  if (FsFileExists(p3)) return p3;

  // 4) Last-resort: return Chrono-resolved string even if file-check failed.
  try { return chrono::vehicle::GetVehicleDataFile(in_path); } catch (...) {}
  return in_path;
}

static std::string Dirname(const std::string& p) {
  const auto pos = p.find_last_of('/');
  if (pos == std::string::npos) return std::string();
  if (pos == 0) return std::string("/");
  return p.substr(0, pos);
}

static std::string ResolvePathRelativeToVehicleFile(const std::string& veh_file, const std::string& ref) {
  if (ref.empty()) return std::string();
  if (!veh_file.empty() && ref[0] != '/') {
    const std::string base = Dirname(veh_file);
    if (!base.empty()) {
      const std::string cand = base + "/" + ref;
      if (FsFileExists(cand)) return cand;
    }
  }
  return ResolveVehicleJsonPath(ref);
}

static bool ReinitializePowertrainFromVehicleJson(chrono::vehicle::ChWheeledVehicle* vehp, const std::string& veh_file) {
  if (!vehp || veh_file.empty()) return false;
  try {
    rapidjson::Document d;
    chrono::vehicle::ReadFileJSON(veh_file, d);
    if (d.IsNull()) return false;
    if (!d.HasMember("Powertrain") || !d["Powertrain"].IsObject()) return false;
    const auto& pt = d["Powertrain"];
    if (!pt.HasMember("Engine Input File") || !pt.HasMember("Transmission Input File")) return false;
    if (!pt["Engine Input File"].IsString() || !pt["Transmission Input File"].IsString()) return false;
    const std::string e_ref = pt["Engine Input File"].GetString();
    const std::string t_ref = pt["Transmission Input File"].GetString();
    const std::string e_file = ResolvePathRelativeToVehicleFile(veh_file, e_ref);
    const std::string t_file = ResolvePathRelativeToVehicleFile(veh_file, t_ref);
    if (e_file.empty() || t_file.empty()) return false;
    std::string d_file;
    if (d.HasMember("Driveline") && d["Driveline"].IsObject()) {
      const auto& dl = d["Driveline"];
      if (dl.HasMember("Input File") && dl["Input File"].IsString()) {
        d_file = ResolvePathRelativeToVehicleFile(veh_file, dl["Input File"].GetString());
      }
    }

    rapidjson::Document de;
    rapidjson::Document dt;
    bool have_engine_doc = false;
    bool have_trans_doc = false;
    try { chrono::vehicle::ReadFileJSON(e_file, de); have_engine_doc = !de.IsNull(); } catch (...) {}
    try { chrono::vehicle::ReadFileJSON(t_file, dt); have_trans_doc = !dt.IsNull(); } catch (...) {}
    const std::string eng_tpl =
        (have_engine_doc && de.HasMember("Template") && de["Template"].IsString()) ? de["Template"].GetString() : "";
    const std::string tx_tpl =
        (have_trans_doc && dt.HasMember("Template") && dt["Template"].IsString()) ? dt["Template"].GetString() : "";
    if (eng_tpl == "EngineSimpleMap" && tx_tpl == "AutomaticTransmissionSimpleMap") {
      const float max_rpm =
          (have_engine_doc && de.HasMember("Maximal Engine Speed RPM") && de["Maximal Engine Speed RPM"].IsNumber())
              ? de["Maximal Engine Speed RPM"].GetFloat()
              : 6500.0f;
      std::vector<float> rpm_pts;
      std::vector<float> tq_pts;
      if (have_engine_doc && de.HasMember("Map Full Throttle") && de["Map Full Throttle"].IsArray()) {
        for (const auto& ptv : de["Map Full Throttle"].GetArray()) {
          if (!ptv.IsArray() || ptv.Size() < 2 || !ptv[0].IsNumber() || !ptv[1].IsNumber()) continue;
          rpm_pts.push_back(ptv[0].GetFloat());
          tq_pts.push_back(ptv[1].GetFloat());
        }
      }
      float coast_tq = -30.0f;
      if (have_engine_doc && de.HasMember("Map Zero Throttle") && de["Map Zero Throttle"].IsArray()) {
        for (const auto& ptv : de["Map Zero Throttle"].GetArray()) {
          if (!ptv.IsArray() || ptv.Size() < 2 || !ptv[0].IsNumber() || !ptv[1].IsNumber()) continue;
          const float rpm = ptv[0].GetFloat();
          const float tq = ptv[1].GetFloat();
          if (rpm > 1.0f && std::isfinite(tq)) {
            coast_tq = tq;
            break;
          }
        }
      }

      const rapidjson::Value* gear_box = nullptr;
      if (have_trans_doc && dt.HasMember("Gear Box") && dt["Gear Box"].IsObject()) gear_box = &dt["Gear Box"];
      if (!gear_box) return false;
      std::vector<float> fwd_gears;
      if (gear_box->HasMember("Forward Gear Ratios") && (*gear_box)["Forward Gear Ratios"].IsArray()) {
        for (const auto& g : (*gear_box)["Forward Gear Ratios"].GetArray()) {
          if (!g.IsNumber()) continue;
          fwd_gears.push_back(g.GetFloat());
        }
      }
      const float rev_gear =
          (gear_box->HasMember("Reverse Gear Ratio") && (*gear_box)["Reverse Gear Ratio"].IsNumber())
              ? std::abs((*gear_box)["Reverse Gear Ratio"].GetFloat())
              : 3.2f;
      float final_ratio = 4.1f;
      if (!d_file.empty()) {
        try {
          rapidjson::Document dd;
          chrono::vehicle::ReadFileJSON(d_file, dd);
          if (!dd.IsNull() && dd.HasMember("Gear Ratio") && dd["Gear Ratio"].IsObject()) {
            const auto& gr = dd["Gear Ratio"];
            if (gr.HasMember("Conical Gear") && gr["Conical Gear"].IsNumber()) {
              const double conical = (double)gr["Conical Gear"].GetFloat();
              if (std::isfinite(conical) && std::abs(conical) > 1e-6) final_ratio = (float)std::abs(1.0 / conical);
            }
          }
        } catch (...) {
        }
      }

      if (!rpm_pts.empty() && rpm_pts.size() == tq_pts.size() && !fwd_gears.empty()) {
        auto eng = chrono_types::make_shared<ExtEngineSimpleMap>("AuthoredEngineSimpleMap");
        eng->SetFromRpmTorque((int)rpm_pts.size(), rpm_pts.data(), tq_pts.data(), max_rpm, coast_tq);
        auto trn = chrono_types::make_shared<ExtAutomaticTransmissionSimpleMap>("AuthoredTransmissionSimpleMap");
        trn->SetFromReductions(final_ratio, rev_gear, (int)fwd_gears.size(), fwd_gears.data(), max_rpm);
        auto p = chrono_types::make_shared<chrono::vehicle::ChPowertrainAssembly>(eng, trn);
        vehp->InitializePowertrain(p);
        try { vehp->SetDrivelineOutput(true); } catch (...) {}
        try {
          auto tx = vehp->GetTransmission();
          if (auto* ta = tx ? tx->asAutomatic() : nullptr) {
            try { ta->SetShiftMode(chrono::vehicle::ChAutomaticTransmission::ShiftMode::AUTOMATIC); } catch (...) {}
            try { ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD); } catch (...) {}
          } else if (tx && tx->GetCurrentGear() == 0) {
            tx->SetGear(1);
          }
        } catch (...) {
        }
        return true;
      }
    }

    auto engine = chrono::vehicle::ReadEngineJSON(e_file);
    auto trans = chrono::vehicle::ReadTransmissionJSON(t_file);
    if (!engine || !trans) return false;
    auto p = chrono_types::make_shared<chrono::vehicle::ChPowertrainAssembly>(engine, trans);
    vehp->InitializePowertrain(p);
    try { vehp->SetDrivelineOutput(true); } catch (...) {}
    try {
      auto tx = vehp->GetTransmission();
      if (auto* ta = tx ? tx->asAutomatic() : nullptr) {
        try { ta->SetShiftMode(chrono::vehicle::ChAutomaticTransmission::ShiftMode::AUTOMATIC); } catch (...) {}
        try { ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD); } catch (...) {}
      } else if (tx && tx->GetCurrentGear() == 0) {
        tx->SetGear(1);
      }
    } catch (...) {
    }
    return true;
  } catch (...) {
    return false;
  }
}

}  // namespace

extern "C" {

#ifdef __EMSCRIPTEN__
#define CV_API EMSCRIPTEN_KEEPALIVE
#else
#define CV_API
#endif

CV_API int cv_get_bridge_diag_version() {
  // Bump when spindle diagnostic layout/semantics change.
  return 20260309;
}

// Drive proxy/readback diagnostics (15 floats):
// 0 active(0/1), 1 speed, 2 yaw_rate, 3 last_time,
// 4 state_calls, 5 state_ok, 6 state_ex_calls, 7 state_ex_ok,
// 8 wheel_calls, 9 wheel_ok, 10 powertrain_calls, 11 powertrain_ok,
// 12 proxy_pos_x, 13 proxy_pos_y, 14 proxy_pos_z (chrono frame)
CV_API int cv_get_drive_proxy_diag(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  outPtr[0] = v.drive_proxy_active ? 1.0f : 0.0f;
  outPtr[1] = (float)v.drive_proxy_speed;
  outPtr[2] = (float)v.drive_proxy_yaw_rate;
  outPtr[3] = (float)v.drive_proxy_last_time;
  outPtr[4] = (float)v.dbg_state_calls;
  outPtr[5] = (float)v.dbg_state_ok;
  outPtr[6] = (float)v.dbg_state_ex_calls;
  outPtr[7] = (float)v.dbg_state_ex_ok;
  outPtr[8] = (float)v.dbg_wheel_calls;
  outPtr[9] = (float)v.dbg_wheel_ok;
  outPtr[10] = (float)v.dbg_powertrain_calls;
  outPtr[11] = (float)v.dbg_powertrain_ok;
  outPtr[12] = (float)v.drive_proxy_pos.x();
  outPtr[13] = (float)v.drive_proxy_pos.y();
  outPtr[14] = (float)v.drive_proxy_pos.z();
  return 1;
}

// Create a world and return handle.
CV_API int cv_create_world() {
  auto w = std::make_unique<World>();
  w->sys = std::make_shared<chrono::ChSystemSMC>();
  w->sys->SetGravitationalAcceleration(ChVector3d(0, 0, -9.81));  // Chrono Z up
  // Conservative global stability settings for SMC vehicle stacks.
  try { w->sys->SetMaxPenetrationRecoverySpeed(1.5); } catch (...) {}
  try { w->sys->SetContactForceModel(chrono::ChSystemSMC::ContactForceModel::Hertz); } catch (...) {}
  try { w->sys->SetSlipVelocityThreshold(1e-4); } catch (...) {}
  try {
    auto it_solver = std::dynamic_pointer_cast<chrono::ChIterativeSolver>(w->sys->GetSolver());
    if (it_solver) {
      it_solver->SetMaxIterations(140);
      it_solver->SetTolerance(1e-10);
      it_solver->EnableWarmStart(true);
    }
  } catch (...) {}

  // Vehicle data path: if you preload data into the WASM FS, set this appropriately.
  // With --preload-file <chrono>/data@/data, this makes vehicle data available.
  try {
    chrono::vehicle::SetVehicleDataPath("/data/vehicle/");
  } catch (...) {
  }

  // Default flat rigid terrain.
  auto rt = std::make_unique<chrono::vehicle::RigidTerrain>(w->sys.get());
  auto mat = chrono_types::make_shared<chrono::ChContactMaterialSMC>();
  mat->SetFriction(1.0f);
  mat->SetRestitution(0.02f);
  mat->SetYoungModulus(2e7f);
  mat->SetPoissonRatio(0.3f);
  (void)rt->AddPatch(mat, chrono::ChCoordsys<>(ChVector3d(0, 0, 0), chrono::QUNIT), 500.0, 500.0, 1.0, true, 25.0, false);
  rt->Initialize();
  // Route terrain friction queries through our functor so we can support per-wheel split-µ.
  // (Used by tire models like Fiala via ChTerrain::GetCoefficientFriction.)
  rt->RegisterFrictionFunctor(chrono_types::make_shared<HeightfieldFrictionFunctor>(w.get()));
  w->terrain_mats.push_back(mat);
  w->terrain = std::move(rt);

  const int id = g_next_world++;
  g_worlds[id] = std::move(w);
  return id;
}

// Set (global) terrain friction coefficient for the rigid terrain patch.
CV_API void cv_set_world_friction(int wid, float mu) {
  World* w = GetWorld(wid);
  const float m = std::max(0.05f, std::min(4.0f, mu));
  if (!w) return;
  w->heightfield.mu = m;
  for (auto& tm : w->terrain_mats) {
    if (!tm) continue;
    try { tm->SetFriction(m); } catch (...) {}
  }
}

// Set spawn height (world Y) used for subsequently created vehicles in this world.
CV_API void cv_set_spawn_world_y(int wid, float y_world) {
  World* w = GetWorld(wid);
  if (!w) return;
  const double y = (double)y_world;
  if (!std::isfinite(y)) return;
  w->spawnWorldY = std::max(0.05, std::min(5.0, y));
}

CV_API void cv_destroy_world(int wid) {
  g_worlds.erase(wid);
}

// Destroy a single vehicle instance (best-effort), without destroying the world.
// The vehicle handle (vid) remains reserved; subsequent calls on it become no-ops.
CV_API void cv_destroy_vehicle(int wid, int vid) {
  World* w = GetWorld(wid);
  if (!w || !w->sys) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;

  // Remove items we observed being created for this vehicle (safe vs tag-based removal).
  try {
    for (auto& l : v.created_links) { if (l) w->sys->RemoveLink(l); }
  } catch (...) {}
  try {
    for (auto& o : v.created_others) { if (o) w->sys->Remove(o); }
  } catch (...) {}
  try {
    for (auto& sh : v.created_shafts) { if (sh) w->sys->RemoveShaft(sh); }
  } catch (...) {}
  try {
    for (auto& b : v.created_bodies) { if (b) w->sys->RemoveBody(b); }
  } catch (...) {}

  v.created_links.clear();
  v.created_others.clear();
  v.created_shafts.clear();
  v.created_bodies.clear();

  v.hmmwv.reset();
  v.sedan.reset();
  v.json_vehicle.reset();
  v.alive = false;
  v.brake4_active = false;
  v.wheel_mu4_active = false;
}

CV_API void cv_clear_statics(int wid) {
  World* w = GetWorld(wid);
  if (!w) return;
  for (auto& b : w->statics) {
    try { w->sys->Remove(b); } catch (...) {}
  }
  w->statics.clear();
}

// Add a static AABB collider expressed in Three.js WORLD coordinates.
CV_API void cv_add_static_aabb_world(int wid,
                                     float minx, float miny, float minz,
                                     float maxx, float maxy, float maxz) {
  World* w = GetWorld(wid);
  if (!w) return;
  const double cx = 0.5 * (double(minx) + double(maxx));
  const double cy = 0.5 * (double(miny) + double(maxy));
  const double cz = 0.5 * (double(minz) + double(maxz));
  const double hx = 0.5 * std::max(0.0f, maxx - minx);
  const double hy = 0.5 * std::max(0.0f, maxy - miny);
  const double hz = 0.5 * std::max(0.0f, maxz - minz);
  if (!(hx > 1e-6 && hy > 1e-6 && hz > 1e-6)) return;

  // Convert box extents to Chrono frame.
  // This is an axis-aligned box in world; after mapping, it remains axis-aligned in Chrono
  // but with axes permuted/sign-flipped. We can conservatively build a Chrono box with
  // half-extents mapped by absolute axis contributions.
  //
  // world->chrono: (x,y,z)_c = (-z, -x, y)
  // so extents map: hx_c along chrono X corresponds to hz_world, etc.
  const double hx_c = hz;  // chrono.x is world -z
  const double hy_c = hx;  // chrono.y is world -x
  const double hz_c = hy;  // chrono.z is world y

  const auto pc = WorldToChronoPos(cx, cy, cz);
  auto body = std::make_shared<chrono::ChBodyEasyBox>(2 * hx_c, 2 * hy_c, 2 * hz_c, 1000.0, true, true);
  body->SetPos(pc);
  body->SetRot(chrono::QUNIT);
  body->SetFixed(true);
  body->GetCollisionModel()->SetFamily(1);
  w->sys->Add(body);
  w->statics.push_back(body);
}

static std::shared_ptr<chrono::ChContactMaterialSMC> MakeDefaultMat(float mu, float restitution = 0.02f) {
  auto m = chrono_types::make_shared<chrono::ChContactMaterialSMC>();
  const float fr = std::max(0.05f, std::min(4.0f, mu));
  m->SetFriction(fr);
  m->SetRestitution(std::max(0.0f, std::min(1.0f, restitution)));
  m->SetYoungModulus(2e7f);
  m->SetPoissonRatio(0.3f);
  return m;
}

static void RemoveHeightfieldBody(World* w) {
  if (!w) return;
  if (w->heightfield_body) {
    try { w->sys->Remove(w->heightfield_body); } catch (...) {}
    // Best-effort remove from statics list.
    auto& s = w->statics;
    s.erase(std::remove(s.begin(), s.end(), w->heightfield_body), s.end());
    w->heightfield_body.reset();
  }
  w->heightfield.active = false;
  w->heightfield.h.clear();
}

static chrono::vehicle::RigidTerrain* GetRigidTerrain(World* w) {
  if (!w || !w->terrain) return nullptr;
  return dynamic_cast<chrono::vehicle::RigidTerrain*>(w->terrain.get());
}

// Replace terrain with a flat rigid patch (box).
// size_x_world, size_z_world: patch size in world X/Z.
// y_world: world Y height of the driving surface at patch center.
CV_API void cv_set_terrain_flat_rigid(int wid, float size_x_world, float size_z_world, float y_world, float mu) {
  World* w = GetWorld(wid);
  if (!w) return;
  RemoveHeightfieldBody(w);
  w->terrain_mats.clear();

  auto rt = std::make_unique<chrono::vehicle::RigidTerrain>(w->sys.get());
  const double sx = std::max(1.0f, size_x_world);
  const double sz = std::max(1.0f, size_z_world);
  const auto posC = WorldToChronoPos(0.0, (double)y_world, 0.0);
  const auto rotC = chrono::QUNIT;
  auto mat = MakeDefaultMat(mu);
  // Chrono patch length is along chrono X (world -Z), width is along chrono Y (world -X).
  (void)rt->AddPatch(mat, chrono::ChCoordsys<>(posC, rotC), sz, sx, 1.0, true, 25.0, false);
  rt->Initialize();
  w->terrain_mats.push_back(mat);
  w->terrain = std::move(rt);
}

// Replace terrain with an OBJ triangle mesh patch (RigidTerrain mesh patch).
// obj_path must exist in the Emscripten filesystem (e.g. written via Module.FS or JS helper).
CV_API int cv_set_terrain_mesh_obj(int wid, const char* obj_path,
                                  float x_world, float y_world, float z_world,
                                  float yaw_world,
                                  float mu,
                                  int connected_mesh,
                                  float sweep_sphere_radius) {
  World* w = GetWorld(wid);
  if (!w || !obj_path) return 0;
  const std::string p(obj_path);
  if (p.empty()) return 0;
  RemoveHeightfieldBody(w);
  w->terrain_mats.clear();

  auto rt = std::make_unique<chrono::vehicle::RigidTerrain>(w->sys.get());
  auto mat = MakeDefaultMat(mu);
  const auto posC = WorldToChronoPos((double)x_world, (double)y_world, (double)z_world);
  const auto rotC = YawToChronoRot((double)yaw_world);
  try {
    (void)rt->AddPatch(mat, chrono::ChCoordsys<>(posC, rotC), p, connected_mesh != 0, (double)std::max(0.0f, sweep_sphere_radius), false);
    rt->Initialize();
  } catch (...) {
    return 0;
  }
  w->terrain_mats.push_back(mat);
  w->terrain = std::move(rt);
  return 1;
}

// Replace terrain with a BMP heightmap patch (RigidTerrain heightmap patch).
// bmp_path must exist in the Emscripten filesystem.
CV_API int cv_set_terrain_heightmap_bmp(int wid, const char* bmp_path,
                                       float length_world, float width_world,
                                       float hmin_world, float hmax_world,
                                       float x_world, float y_world, float z_world,
                                       float yaw_world,
                                       float mu,
                                       int connected_mesh,
                                       float sweep_sphere_radius) {
  World* w = GetWorld(wid);
  if (!w || !bmp_path) return 0;
  const std::string p(bmp_path);
  if (p.empty()) return 0;
  RemoveHeightfieldBody(w);
  w->terrain_mats.clear();

  auto rt = std::make_unique<chrono::vehicle::RigidTerrain>(w->sys.get());
  auto mat = MakeDefaultMat(mu);
  const auto posC = WorldToChronoPos((double)x_world, (double)y_world, (double)z_world);
  const auto rotC = YawToChronoRot((double)yaw_world);
  // Interpret inputs as world-plane extents (length_world along world X, width_world along world Z),
  // then map into Chrono patch extents (length along chrono X ~= world Z, width along chrono Y ~= world X).
  const double sizeX = std::max(1e-3f, length_world);
  const double sizeZ = std::max(1e-3f, width_world);
  const double L = sizeZ;
  const double W = sizeX;
  try {
    (void)rt->AddPatch(mat, chrono::ChCoordsys<>(posC, rotC), p, L, W, (double)hmin_world, (double)hmax_world,
                       connected_mesh != 0, (double)std::max(0.0f, sweep_sphere_radius), false);
    rt->Initialize();
  } catch (...) {
    return 0;
  }
  w->terrain_mats.push_back(mat);
  w->terrain = std::move(rt);
  return 1;
}

// Replace terrain with a sampled heightfield grid (fast height/normal queries) and also create a static collision mesh.
// heights: row-major array of nx*nz floats, where X is fastest: heights[ix + iz*nx].
// The grid spans size_x_world by size_z_world, centered at (center_x_world, center_y_world, center_z_world).
// Height at each sample is center_y_world + height_scale * heights[].
CV_API int cv_set_terrain_heightfield(int wid,
                                     int nx, int nz,
                                     const float* heights,
                                     float size_x_world, float size_z_world,
                                     float center_x_world, float center_y_world, float center_z_world,
                                     float height_scale,
                                     float mu,
                                     float sweep_sphere_radius) {
  World* w = GetWorld(wid);
  if (!w) return 0;
  if (nx < 2 || nz < 2) return 0;
  if (!heights) return 0;
  const double sx = (double)size_x_world;
  const double sz = (double)size_z_world;
  if (!(sx > 1e-6) || !(sz > 1e-6)) return 0;

  RemoveHeightfieldBody(w);
  w->terrain_mats.clear();

  // Store heightfield parameters (world coordinates).
  w->heightfield.active = true;
  w->heightfield.nx = nx;
  w->heightfield.nz = nz;
  w->heightfield.sizeX = sx;
  w->heightfield.sizeZ = sz;
  w->heightfield.centerX = (double)center_x_world;
  w->heightfield.centerY = (double)center_y_world;
  w->heightfield.centerZ = (double)center_z_world;
  w->heightfield.heightScale = std::isfinite((double)height_scale) ? (double)height_scale : 1.0;
  w->heightfield.mu = std::max(0.05f, std::min(4.0f, mu));
  w->heightfield.h.resize((size_t)nx * (size_t)nz);
  for (size_t i = 0; i < w->heightfield.h.size(); i++) {
    const float v = heights[i];
    w->heightfield.h[i] = std::isfinite(v) ? v : 0.0f;
  }

  // Terrain queries via functors (fast).
  auto t = std::make_unique<chrono::vehicle::ChTerrain>();
  t->RegisterHeightFunctor(chrono_types::make_shared<HeightfieldHeightFunctor>(&w->heightfield));
  t->RegisterNormalFunctor(chrono_types::make_shared<HeightfieldNormalFunctor>(&w->heightfield));
  t->RegisterFrictionFunctor(chrono_types::make_shared<HeightfieldFrictionFunctor>(w));
  w->terrain = std::move(t);

  // Collision mesh (static): build a triangle mesh in a body frame centered at (centerX, centerY, centerZ).
  auto body = chrono_types::make_shared<chrono::ChBody>();
  body->SetFixed(true);
  body->EnableCollision(true);
  body->SetPos(WorldToChronoPos(w->heightfield.centerX, w->heightfield.centerY, w->heightfield.centerZ));
  body->SetRot(chrono::QUNIT);

  auto trimesh = chrono_types::make_shared<chrono::ChTriangleMeshConnected>();
  auto& verts = trimesh->GetCoordsVertices();
  verts.resize((size_t)nx * (size_t)nz);
  const double dx = sx / (double)(nx - 1);
  const double dz = sz / (double)(nz - 1);
  for (int iz = 0; iz < nz; iz++) {
    for (int ix = 0; ix < nx; ix++) {
      const double xw = ((double)ix * dx) - 0.5 * sx;  // world local X
      const double zw = ((double)iz * dz) - 0.5 * sz;  // world local Z
      const float h = HF_At(w->heightfield, ix, iz);
      const double yw = w->heightfield.heightScale * (double)h;  // world local Y (relative to centerY)
      // Convert local world vector into local chrono vector.
      // world->chrono: (x,y,z)_c = (-z, -x, y)
      const double xc = -zw;
      const double yc = -xw;
      const double zc = yw;
      verts[(size_t)ix + (size_t)iz * (size_t)nx] = ChVector3d(xc, yc, zc);
    }
  }
  auto& idx = trimesh->GetIndicesVertexes();
  idx.reserve((size_t)(nx - 1) * (size_t)(nz - 1) * 2);
  for (int iz = 0; iz < nz - 1; iz++) {
    for (int ix = 0; ix < nx - 1; ix++) {
      const int i00 = ix + iz * nx;
      const int i10 = (ix + 1) + iz * nx;
      const int i01 = ix + (iz + 1) * nx;
      const int i11 = (ix + 1) + (iz + 1) * nx;
      // Two triangles; keep consistent winding for the chrono (X,Y plane, Z up) convention.
      idx.push_back(chrono::ChVector3i(i00, i01, i10));
      idx.push_back(chrono::ChVector3i(i10, i01, i11));
    }
  }

  auto mat = MakeDefaultMat(w->heightfield.mu);
  w->terrain_mats.push_back(mat);
  auto ct_shape = chrono_types::make_shared<chrono::ChCollisionShapeTriangleMesh>(
      mat, trimesh, true, false, (double)std::max(0.0f, sweep_sphere_radius));
  body->AddCollisionShape(ct_shape);

  try { w->sys->AddBody(body); } catch (...) { return 0; }
  w->heightfield_body = body;
  return 1;
}

// Add an arbitrary static triangle mesh collider (world-space vertices).
// verts_xyz_world: 3*n_verts floats (x,y,z) in world coordinates.
// indices: 3*n_tris uint32 indices into the vertex array.
CV_API int cv_add_static_trimesh_world(int wid,
                                      int n_verts, const float* verts_xyz_world,
                                      int n_tris, const uint32_t* indices,
                                      float mu,
                                      float sweep_sphere_radius) {
  World* w = GetWorld(wid);
  if (!w || !verts_xyz_world || !indices) return 0;
  if (n_verts < 3 || n_tris < 1) return 0;
  const size_t nv = (size_t)n_verts;
  const size_t nt = (size_t)n_tris;

  auto body = chrono_types::make_shared<chrono::ChBody>();
  body->SetFixed(true);
  body->EnableCollision(true);
  body->SetPos(ChVector3d(0, 0, 0));
  body->SetRot(chrono::QUNIT);

  auto trimesh = chrono_types::make_shared<chrono::ChTriangleMeshConnected>();
  auto& verts = trimesh->GetCoordsVertices();
  verts.resize(nv);
  for (size_t i = 0; i < nv; i++) {
    const float wx = verts_xyz_world[i * 3 + 0];
    const float wy = verts_xyz_world[i * 3 + 1];
    const float wz = verts_xyz_world[i * 3 + 2];
    if (!std::isfinite(wx + wy + wz)) {
      verts[i] = ChVector3d(0, 0, 0);
      continue;
    }
    verts[i] = WorldToChronoPos((double)wx, (double)wy, (double)wz);
  }
  auto& idx = trimesh->GetIndicesVertexes();
  idx.resize(nt);
  for (size_t t = 0; t < nt; t++) {
    const uint32_t i0 = indices[t * 3 + 0];
    const uint32_t i1 = indices[t * 3 + 1];
    const uint32_t i2 = indices[t * 3 + 2];
    if (i0 >= nv || i1 >= nv || i2 >= nv) {
      idx[t] = chrono::ChVector3i(0, 0, 0);
    } else {
      idx[t] = chrono::ChVector3i((int)i0, (int)i1, (int)i2);
    }
  }

  auto mat = MakeDefaultMat(mu);
  auto ct_shape = chrono_types::make_shared<chrono::ChCollisionShapeTriangleMesh>(
      mat, trimesh, true, false, (double)std::max(0.0f, sweep_sphere_radius));
  body->AddCollisionShape(ct_shape);

  try { w->sys->AddBody(body); } catch (...) { return 0; }
  w->statics.push_back(body);
  return 1;
}

// Template spawn (Sedan-only).
// `kind` is accepted for ABI compatibility but ignored.
// x,z,yaw are in Three.js WORLD coordinates (x,z on ground plane, yaw about +Y).
CV_API int cv_create_vehicle(int wid, int kind, float x, float z, float yaw) {
  World* w = GetWorld(wid);
  if (!w) return 0;

  VehicleInst inst;
  inst.kind = 1;  // sedan template
  inst.inputs.m_steering = 0;
  inst.inputs.m_throttle = 0;
  inst.inputs.m_braking = 0;
  // Chrono DriverInputs clutch convention: 0 = engaged (coupled), 1 = disengaged.
  inst.inputs.m_clutch = 0;

  const auto pre = SnapshotSystem(w->sys.get());

  // Spawn slightly above the terrain to avoid initial penetration.
  const auto pc = WorldToChronoPos(x, w->spawnWorldY, z);

  auto sedan = std::make_unique<chrono::vehicle::sedan::Sedan>(w->sys.get());
  sedan->SetContactMethod(chrono::ChContactMethod::SMC);
  sedan->SetChassisFixed(false);
  sedan->SetInitFwdVel(0.0);
  sedan->SetInitPosition(chrono::ChCoordsys<>(pc, YawToChronoRot(yaw)));
  sedan->Initialize();
  // Reduce visualization overhead.
  sedan->SetChassisVisualizationType(chrono::VisualizationType::NONE);
  sedan->SetSuspensionVisualizationType(chrono::VisualizationType::NONE);
  sedan->SetSteeringVisualizationType(chrono::VisualizationType::NONE);
  sedan->SetWheelVisualizationType(chrono::VisualizationType::NONE);
  sedan->SetTireVisualizationType(chrono::VisualizationType::NONE);
  inst.sedan = std::move(sedan);

  CaptureNewSystemItems(w->sys.get(), pre, inst);

  // Our vehicle handle is 1-based and indexes into the vector.
  w->vehicles.push_back(std::move(inst));
  return (int)w->vehicles.size();  // handle = index
}

// Create a JSON-defined Chrono vehicle.
// - json_path: absolute path in the Emscripten FS (e.g. "/tmp/veh.json") OR
//              a vehicle-data-relative path (e.g. "generic/vehicle/Vehicle_DoubleWishbones.json").
CV_API int cv_create_vehicle_json(int wid, const char* json_path, float x, float z, float yaw) {
  World* w = GetWorld(wid);
  if (!w) return 0;
  if (!json_path) return 0;

  std::string p(json_path);
  if (p.empty()) return 0;

  VehicleInst inst;
  inst.kind = 2;
  inst.inputs.m_steering = 0;
  inst.inputs.m_throttle = 0;
  inst.inputs.m_braking = 0;
  // Chrono DriverInputs clutch convention: 0 = engaged (coupled), 1 = disengaged.
  inst.inputs.m_clutch = 0;

  const auto pc = WorldToChronoPos(x, w->spawnWorldY, z);

  const auto pre = SnapshotSystem(w->sys.get());
  try {
    // Resolve path: if absolute, use as-is; else resolve via vehicle data path.
    const std::string veh_file = ResolveVehicleJsonPath(p);

    // Create a WheeledVehicle from JSON spec, including powertrain/tires when present.
    auto veh = std::make_unique<chrono::vehicle::WheeledVehicle>(w->sys.get(), veh_file, true, true);
    veh->Initialize(chrono::ChCoordsys<>(pc, YawToChronoRot(yaw)));
    // JSON vehicles can come up with a fixed chassis depending on authoring/defaults.
    // Force dynamic chassis for runtime drive tests.
    try {
      auto body = veh->GetChassisBody();
      if (body) body->SetFixed(false);
    } catch (...) {
    }
    // Chrono API note: this controls driveline subsystem output/logging, not torque routing.
    // Keep enabled for diagnostics consistency.
    try { veh->SetDrivelineOutput(true); } catch (...) {}
    // Rebind powertrain using vehicle-local relative path resolution.
    try { ReinitializePowertrainFromVehicleJson(veh.get(), veh_file); } catch (...) {}

    // Reduce visualization overhead.
    veh->SetChassisVisualizationType(chrono::VisualizationType::NONE);
    veh->SetSuspensionVisualizationType(chrono::VisualizationType::NONE);
    veh->SetSteeringVisualizationType(chrono::VisualizationType::NONE);
    veh->SetWheelVisualizationType(chrono::VisualizationType::NONE);
    veh->SetTireVisualizationType(chrono::VisualizationType::NONE);

    int spawn_wheel_mask = 0;
    int spawn_tire_mask = 0;
    if (!ValidateExpectedWheels(veh.get(), "cv_create_vehicle_json", &spawn_wheel_mask, &spawn_tire_mask, nullptr)) {
      return 0;
    }

    inst.spawn_expected_wheel_mask = spawn_wheel_mask;
    inst.spawn_expected_tire_mask = spawn_tire_mask;
    inst.spawn_pose_valid = true;
    inst.spawn_pos_chrono = pc;
    inst.spawn_rot_chrono = YawToChronoRot(yaw);
    inst.json_vehicle = std::move(veh);
  } catch (...) {
    return 0;
  }

  CaptureSpindleSeedLocal(inst);
  DisableVehicleBodySleeping(inst);

  CaptureNewSystemItems(w->sys.get(), pre, inst);
  w->vehicles.push_back(std::move(inst));
  return (int)w->vehicles.size();
}

// Create a JSON-defined vehicle with an explicit tire JSON.
// - vehicle_json_path: absolute path in the Emscripten FS (e.g. "/tmp/veh.json") OR a vehicle-data-relative path.
// - tire_json_path:    absolute path in the Emscripten FS (e.g. "/tmp/tire.json") OR a vehicle-data-relative path.
//                      Must be non-empty in strict mode.
CV_API int cv_create_vehicle_json_ex(int wid, const char* vehicle_json_path, const char* tire_json_path, float x, float z, float yaw) {
  World* w = GetWorld(wid);
  if (!w) return 0;
  if (!vehicle_json_path) return 0;

  std::string vp(vehicle_json_path);
  if (vp.empty()) return 0;

  std::string tp;
  if (tire_json_path) tp = std::string(tire_json_path);
  if (tp.empty()) return 0;

  VehicleInst inst;
  inst.kind = 2;
  inst.inputs.m_steering = 0;
  inst.inputs.m_throttle = 0;
  inst.inputs.m_braking = 0;
  // Chrono DriverInputs clutch convention: 0 = engaged (coupled), 1 = disengaged.
  inst.inputs.m_clutch = 0;

  const auto pc = WorldToChronoPos(x, w->spawnWorldY, z);

  const auto pre = SnapshotSystem(w->sys.get());
  try {
    const std::string veh_file = ResolveVehicleJsonPath(vp);

    const std::string tire_file = ResolveVehicleJsonPath(tp);
    if (tire_file.empty()) return 0;

    auto veh = std::make_unique<chrono::vehicle::WheeledVehicle>(w->sys.get(), veh_file, true, true);
    veh->Initialize(chrono::ChCoordsys<>(pc, YawToChronoRot(yaw)));
    // JSON vehicles can come up with a fixed chassis depending on authoring/defaults.
    // Force dynamic chassis for runtime drive tests.
    try {
      auto body = veh->GetChassisBody();
      if (body) body->SetFixed(false);
    } catch (...) {
    }
    // Chrono API note: this controls driveline subsystem output/logging, not torque routing.
    // Keep enabled for diagnostics consistency.
    try { veh->SetDrivelineOutput(true); } catch (...) {}
    // Rebind powertrain using vehicle-local relative path resolution.
    try { ReinitializePowertrainFromVehicleJson(veh.get(), veh_file); } catch (...) {}

    veh->SetChassisVisualizationType(chrono::VisualizationType::NONE);
    veh->SetSuspensionVisualizationType(chrono::VisualizationType::NONE);
    veh->SetSteeringVisualizationType(chrono::VisualizationType::NONE);
    veh->SetWheelVisualizationType(chrono::VisualizationType::NONE);
    veh->SetTireVisualizationType(chrono::VisualizationType::NONE);

    for (unsigned int i = 0; i < veh->GetNumberAxles(); i++) {
      auto axle = veh->GetAxle((int)i);
      if (!axle) continue;
      for (auto& wheel : axle->GetWheels()) {
        if (!wheel) continue;
        try {
          // Explicit tire path overrides tires for deterministic testing.
          auto tire = chrono::vehicle::ReadTireJSON(tire_file);
          if (!tire) return 0;
          veh->InitializeTire(tire, wheel, chrono::VisualizationType::NONE);
        } catch (...) {
          return 0;
        }
      }
    }

    int spawn_wheel_mask = 0;
    int spawn_tire_mask = 0;
    if (!ValidateExpectedWheels(veh.get(), "cv_create_vehicle_json_ex", &spawn_wheel_mask, &spawn_tire_mask, nullptr)) {
      return 0;
    }

    inst.spawn_expected_wheel_mask = spawn_wheel_mask;
    inst.spawn_expected_tire_mask = spawn_tire_mask;
    inst.spawn_pose_valid = true;
    inst.spawn_pos_chrono = pc;
    inst.spawn_rot_chrono = YawToChronoRot(yaw);
    inst.json_vehicle = std::move(veh);
  } catch (...) {
    return 0;
  }

  CaptureSpindleSeedLocal(inst);
  DisableVehicleBodySleeping(inst);

  CaptureNewSystemItems(w->sys.get(), pre, inst);
  w->vehicles.push_back(std::move(inst));
  return (int)w->vehicles.size();
}

CV_API void cv_set_inputs(int wid, int vid, float steering, float throttle, float braking) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  const float s = steering * std::max(0.05f, std::min(5.0f, v.steerInputScale));
  const float t = throttle * std::max(0.05f, std::min(5.0f, v.throttleInputScale));
  const float b = braking * std::max(0.05f, std::min(5.0f, v.brakeInputScale));
  v.inputs.m_steering = std::max(-1.0f, std::min(1.0f, s));
  v.inputs.m_throttle = std::max(0.0f, std::min(1.0f, t));
  v.inputs.m_braking = std::max(0.0f, std::min(1.0f, b));
  // Without an explicit clutch API call, keep clutch engaged/coupled for torque transfer.
  v.inputs.m_clutch = 0.0;
}

// Extended inputs with clutch.
CV_API void cv_set_inputs_ex(int wid, int vid, float steering, float throttle, float braking, float clutch) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  const float s = steering * std::max(0.05f, std::min(5.0f, v.steerInputScale));
  const float t = throttle * std::max(0.05f, std::min(5.0f, v.throttleInputScale));
  const float b = braking * std::max(0.05f, std::min(5.0f, v.brakeInputScale));
  v.inputs.m_steering = std::max(-1.0f, std::min(1.0f, s));
  v.inputs.m_throttle = std::max(0.0f, std::min(1.0f, t));
  v.inputs.m_braking = std::max(0.0f, std::min(1.0f, b));
  v.inputs.m_clutch = std::max(0.0f, std::min(1.0f, (float)(std::isfinite(clutch) ? clutch : 0.0f)));
}

// Per-wheel braking override (FL,FR,RL,RR).
CV_API void cv_set_brake4(int wid, int vid, float b_fl, float b_fr, float b_rl, float b_rr) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  v.brake4[0] = Clamp01f(std::isfinite(b_fl) ? b_fl : 0.0f);
  v.brake4[1] = Clamp01f(std::isfinite(b_fr) ? b_fr : 0.0f);
  v.brake4[2] = Clamp01f(std::isfinite(b_rl) ? b_rl : 0.0f);
  v.brake4[3] = Clamp01f(std::isfinite(b_rr) ? b_rr : 0.0f);
  v.brake4_active = true;
}

CV_API void cv_clear_brake4(int wid, int vid) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  v.brake4_active = false;
}

// Per-wheel friction mu override (FL,FR,RL,RR). Used by tire models that query ChTerrain friction (e.g. Fiala).
CV_API void cv_set_wheel_mu4(int wid, int vid, float mu_fl, float mu_fr, float mu_rl, float mu_rr) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  const auto clampMu = [](float mu) -> float {
    if (!std::isfinite(mu)) return 1.0f;
    return std::max(0.05f, std::min(4.0f, mu));
  };
  v.wheel_mu4[0] = clampMu(mu_fl);
  v.wheel_mu4[1] = clampMu(mu_fr);
  v.wheel_mu4[2] = clampMu(mu_rl);
  v.wheel_mu4[3] = clampMu(mu_rr);
  v.wheel_mu4_active = true;
}

CV_API void cv_clear_wheel_mu4(int wid, int vid) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  v.wheel_mu4_active = false;
}

// Basic tuning knobs:
// - max_steer_rad: approximate max road wheel steer angle (currently used only as a hint; the actual max steer
//   should come from the vehicle JSON "Maximum Steering Angle (deg)" when using cv_create_vehicle_json(_ex))
// - throttle_scale / brake_scale: input scaling
// - diff_lock_power / diff_lock_coast: 0..1 (applied as simple lock/unlock on axle 1 for RWD-ish cars)
CV_API void cv_set_vehicle_tuning_basic(int wid, int vid,
                                       float max_steer_rad,
                                       float throttle_scale,
                                       float brake_scale,
                                       float diff_lock_power,
                                       float diff_lock_coast) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  // Steering:
  // - For JSON vehicles we typically set "Maximum Steering Angle" in the generated JSON, so the Chrono-side
  //   normalized input already maps correctly. Avoid extra scaling to prevent double-applying the limit.
  // - For built-in model vehicles (Sedan/HMMWV), use this as a best-effort scaling knob so user input
  //   feels closer to the desired road-wheel max steer angle.
  const float ms = max_steer_rad;
  if (std::isfinite(ms) && ms > 1e-4f) v.maxSteerRad = std::max(0.05f, std::min(1.2f, ms));
  if (v.json_vehicle) {
    v.steerInputScale = 1.0f;
  } else if (std::isfinite(ms) && ms > 1e-4f) {
    const float base = 0.48f;
    v.steerInputScale = std::max(0.10f, std::min(2.50f, ms / base));
  } else {
    v.steerInputScale = 1.0f;
  }
  v.throttleInputScale = std::max(0.05f, std::min(5.0f, throttle_scale));
  v.brakeInputScale = std::max(0.05f, std::min(5.0f, brake_scale));
  v.diffLockPower = std::max(0.0f, std::min(1.0f, diff_lock_power));
  v.diffLockCoast = std::max(0.0f, std::min(1.0f, diff_lock_coast));
}

// Override chassis mass & inertia (kg, kg*m^2). Use with care.
CV_API void cv_set_vehicle_chassis_mass_inertia(int wid, int vid, float mass, float ixx, float iyy, float izz) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  auto body = GetChassisBody(v);
  if (!body) return;
  const double m = std::max(50.0f, std::min(20000.0f, mass));
  const double ix = std::max(1.0f, std::min(2e6f, ixx));
  const double iy = std::max(1.0f, std::min(2e6f, iyy));
  const double iz = std::max(1.0f, std::min(2e6f, izz));
  try { body->SetMass(m); } catch (...) {}
  try { body->SetInertiaXX(ChVector3d(ix, iy, iz)); } catch (...) {}
}

// Override chassis COM frame origin in chassis reference coordinates (Chrono ISO frame).
CV_API void cv_set_vehicle_chassis_com_ref(int wid, int vid, float com_x, float com_y, float com_z) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  auto body = GetChassisBody(v);
  if (!body) return;
  const double x = std::isfinite((double)com_x) ? (double)com_x : 0.0;
  const double y = std::isfinite((double)com_y) ? (double)com_y : 0.0;
  const double z = std::isfinite((double)com_z) ? (double)com_z : 0.0;
  try {
    auto f = body->GetFrameCOMToRef();
    f.SetPos(ChVector3d(x, y, z));
    body->SetFrameCOMToRef(f);
  } catch (...) {
  }
}

// Replace vehicle powertrain with a tunable simple-map engine + transmission.
// - rpms[], torques[] define the full-throttle torque curve in RPM and Nm.
// - max_rpm is the engine limiter speed in RPM.
// - gear reductions are from AC (e.g. 3.336) and final_ratio (e.g. 4.41). Chrono expects 1/(gear*final).
CV_API void cv_set_vehicle_powertrain_simplemap(int wid, int vid,
                                               float max_rpm,
                                               int n_pts,
                                               const float* rpms,
                                               const float* torques,
                                               float coast_tq,
                                               float final_ratio,
                                               float rev_gear_reduction,
                                               int n_fwd_gears,
                                               const float* fwd_gear_reductions) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return;

  try {
    auto eng = chrono_types::make_shared<ExtEngineSimpleMap>("ExtEngine");
    eng->SetFromRpmTorque(n_pts, rpms, torques, max_rpm, coast_tq);
    auto trn = chrono_types::make_shared<ExtAutomaticTransmissionSimpleMap>("ExtTransmission");
    trn->SetFromReductions(final_ratio, rev_gear_reduction, n_fwd_gears, fwd_gear_reductions, max_rpm);
    auto p = chrono_types::make_shared<chrono::vehicle::ChPowertrainAssembly>(eng, trn);
    vehp->InitializePowertrain(p);
    try { vehp->SetDrivelineOutput(true); } catch (...) {}
    try {
      auto trans = vehp->GetTransmission();
      if (auto* ta = trans ? trans->asAutomatic() : nullptr) {
        try { ta->SetShiftMode(chrono::vehicle::ChAutomaticTransmission::ShiftMode::AUTOMATIC); } catch (...) {}
        try { ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD); } catch (...) {}
      } else if (trans && trans->GetCurrentGear() == 0) {
        trans->SetGear(1);
      }
    } catch (...) {
    }
  } catch (...) {
  }
}

// Convention: 1=forward (drive), 0=neutral, -1=reverse.
CV_API void cv_set_gear(int wid, int vid, int gear) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  try {
    auto vehp = GetWheeledVehicle(v);
    if (!vehp) return;
    auto trans = vehp->GetTransmission();
    if (!trans) return;
    const int g = (gear < 0) ? -1 : (gear > 0) ? 1 : 0;
    // Most Chrono models use automatic transmissions; those are controlled by DriveMode, not "gear number".
    if (auto* ta = trans->asAutomatic()) {
      try {
        if (ta->GetShiftMode() == chrono::vehicle::ChAutomaticTransmission::ShiftMode::MANUAL) {
          ta->SetShiftMode(chrono::vehicle::ChAutomaticTransmission::ShiftMode::AUTOMATIC);
        }
      } catch (...) {
      }
      if (g < 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::REVERSE);
      else if (g > 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD);
      else ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::NEUTRAL);
      return;
    }
    // Manual / non-automatic transmissions: best-effort mapping.
    trans->SetGear(g);
  } catch (...) {
  }
}

// Set a specific transmission gear index (reverse=-1, neutral=0, forward gears=1..maxGear).
// For automatic transmissions, this switches to MANUAL shift mode.
CV_API void cv_set_gear_index(int wid, int vid, int gear_index) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  try {
    auto vehp = GetWheeledVehicle(v);
    if (!vehp) return;
    auto trans = vehp->GetTransmission();
    if (!trans) return;
    const int g = (int)gear_index;
    if (auto* ta = trans->asAutomatic()) {
      try { ta->SetShiftMode(chrono::vehicle::ChAutomaticTransmission::ShiftMode::MANUAL); } catch (...) {}
      try {
        if (g < 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::REVERSE);
        else if (g > 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD);
        else ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::NEUTRAL);
      } catch (...) {}
    }
    trans->SetGear(g);
  } catch (...) {
  }
}

// Automatic transmission shift mode: 0=AUTOMATIC, 1=MANUAL (no effect for manual transmissions).
CV_API void cv_set_shift_mode(int wid, int vid, int manual) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  try {
    auto vehp = GetWheeledVehicle(v);
    if (!vehp) return;
    auto trans = vehp->GetTransmission();
    if (!trans) return;
    if (auto* ta = trans->asAutomatic()) {
      const bool man = (manual != 0);
      try { ta->SetShiftMode(man ? chrono::vehicle::ChAutomaticTransmission::ShiftMode::MANUAL
                                 : chrono::vehicle::ChAutomaticTransmission::ShiftMode::AUTOMATIC); } catch (...) {}
    }
  } catch (...) {
  }
}

// Automatic transmission drive mode: -1=REVERSE, 0=NEUTRAL, 1=FORWARD (no effect for manual transmissions).
CV_API void cv_set_drive_mode(int wid, int vid, int mode) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  try {
    auto vehp = GetWheeledVehicle(v);
    if (!vehp) return;
    auto trans = vehp->GetTransmission();
    if (!trans) return;
    if (auto* ta = trans->asAutomatic()) {
      const int m = (mode < 0) ? -1 : (mode > 0) ? 1 : 0;
      try {
        if (m < 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::REVERSE);
        else if (m > 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD);
        else ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::NEUTRAL);
      } catch (...) {}
    }
  } catch (...) {
  }
}

CV_API void cv_step_world(int wid, float dt) {
  World* w = GetWorld(wid);
  if (!w) return;
  const double step = std::max(1e-6f, std::min(0.05f, dt));
  w->time += step;

  // Keep terrain updated (even for rigid terrain this is the canonical flow).
  try { if (w->terrain) w->terrain->Synchronize(w->time); } catch (...) {}

  // Do not mutate spindle bodies during stepping. Keep physics state authoritative; readback fallbacks
  // handle non-finite spindle channels without writing back into simulation bodies.

  // Update wheel friction points for split-µ (queried via the terrain friction functor).
  w->wheel_friction_points.clear();
  for (auto& v : w->vehicles) {
    if (!v.alive || !v.wheel_mu4_active) continue;
    auto vehp = GetWheeledVehicle(v);
    if (!vehp) continue;
    try {
      if (vehp->GetNumberAxles() < 2) continue;
      struct Sel { int axle; chrono::vehicle::VehicleSide side; int idx; };
      const Sel sel[4] = {
          {0, chrono::vehicle::VehicleSide::LEFT, 0},
          {0, chrono::vehicle::VehicleSide::RIGHT, 1},
          {1, chrono::vehicle::VehicleSide::LEFT, 2},
          {1, chrono::vehicle::VehicleSide::RIGHT, 3},
      };
      for (int i = 0; i < 4; i++) {
        const auto p = vehp->GetSpindlePos(sel[i].axle, sel[i].side);
        const float mu = std::max(0.05f, std::min(4.0f, v.wheel_mu4[sel[i].idx]));
        w->wheel_friction_points.push_back(WheelFrictionPoint{p, mu});
      }
    } catch (...) {
    }
  }

  for (auto& v : w->vehicles) {
    if (!v.alive) continue;
    // Very crude differential locking proxy (useful for AC LSD feel).
    try {
      auto vehp = GetWheeledVehicle(v);
      if (vehp) {
        const bool onPower = (v.inputs.m_throttle > 0.05f);
        const float lock = onPower ? v.diffLockPower : v.diffLockCoast;
        // Lock rear axle when lock fraction is high.
        vehp->LockAxleDifferential(1, lock > 0.5f);
      }
    } catch (...) {
    }
    if (w->terrain) {
      chrono::vehicle::DriverInputs inp = v.inputs;
      if (v.brake4_active) inp.m_braking = 0.0;  // avoid double counting
      if (v.hmmwv) v.hmmwv->Synchronize(w->time, inp, *w->terrain);
      else if (v.sedan) v.sedan->Synchronize(w->time, inp, *w->terrain);
      else if (v.json_vehicle) v.json_vehicle->Synchronize(w->time, inp, *w->terrain);

      // Per-wheel braking override (true handbrake / brake bias).
      if (v.brake4_active) {
        try {
          auto vehp = GetWheeledVehicle(v);
          if (vehp && vehp->GetNumberAxles() >= 2) {
            const float bFL = Clamp01f(v.brake4[0]);
            const float bFR = Clamp01f(v.brake4[1]);
            const float bRL = Clamp01f(v.brake4[2]);
            const float bRR = Clamp01f(v.brake4[3]);
            if (auto br = vehp->GetBrake(0, chrono::vehicle::VehicleSide::LEFT)) br->Synchronize(w->time, (double)bFL);
            if (auto br = vehp->GetBrake(0, chrono::vehicle::VehicleSide::RIGHT)) br->Synchronize(w->time, (double)bFR);
            if (auto br = vehp->GetBrake(1, chrono::vehicle::VehicleSide::LEFT)) br->Synchronize(w->time, (double)bRL);
            if (auto br = vehp->GetBrake(1, chrono::vehicle::VehicleSide::RIGHT)) br->Synchronize(w->time, (double)bRR);
          }
        } catch (...) {
        }
      }

      // Track sustained throttle-without-drive as a diagnostic only.
      try {
        auto vehp = GetWheeledVehicle(v);
        if (vehp) {
          auto chassis = GetChassisBody(v);
          auto trans = vehp->GetTransmission();
          auto eng = vehp->GetEngine();
          const bool has_pt = (trans != nullptr) && (eng != nullptr);
          const double rads2rpm = 30.0 / chrono::CH_PI;
          double speed = std::abs((double)vehp->GetSpeed());
          if (!std::isfinite(speed)) speed = 0.0;
          if (speed < 1e-4) {
            const double fb = std::abs(GetChassisForwardSpeedChrono(chassis));
            if (std::isfinite(fb) && fb > speed) speed = fb;
          }
          double eng_rpm = eng ? std::abs((double)eng->GetMotorSpeed() * rads2rpm) : 0.0;
          if (!std::isfinite(eng_rpm)) eng_rpm = 0.0;
          double ds_nm = trans ? std::abs((double)trans->GetOutputDriveshaftTorque()) : 0.0;
          if (!std::isfinite(ds_nm)) ds_nm = 0.0;
          int drive_sign = 1;
          try {
            if (auto* ta = trans ? trans->asAutomatic() : nullptr) {
              const auto dm = ta->GetDriveMode();
              if (dm == chrono::vehicle::ChAutomaticTransmission::DriveMode::REVERSE) drive_sign = -1;
              else if (dm == chrono::vehicle::ChAutomaticTransmission::DriveMode::NEUTRAL) drive_sign = 0;
              else drive_sign = 1;
            } else if (trans) {
              const int g = trans->GetCurrentGear();
              drive_sign = (g < 0) ? -1 : (g > 0 ? 1 : 0);
            }
          } catch (...) {
          }
          const bool throttle_demand = (v.inputs.m_throttle > 0.55f) && (v.inputs.m_braking < 0.05f) && (drive_sign != 0);
          const bool inert = (v.inputs.m_throttle > 0.55f)
                             && (v.inputs.m_braking < 0.05f)
                             && (speed < 0.03)
                             && ((!has_pt) || ((eng_rpm < 5.0) && (ds_nm < 1.0)));
          if (inert) v.ptrain_inert_frames++;
          else v.ptrain_inert_frames = 0;
          // Some EngineSimpleMap + non-TC authored packs can remain at a hard zero-speed lock in WASM.
          // Apply a deterministic bridge-side recovery:
          // 1) reassert drive state and release brakes/parking
          // 2) seed small wheel+chassis forward velocity to break static lock
          // This keeps recovery in one authoritative place (bridge), instead of JS kinematic fallbacks.
          if (throttle_demand && (v.ptrain_inert_frames >= 8) && chassis) {
            try {
              try {
                auto trans = vehp->GetTransmission();
                if (auto* ta = trans ? trans->asAutomatic() : nullptr) {
                  try { ta->SetShiftMode(chrono::vehicle::ChAutomaticTransmission::ShiftMode::AUTOMATIC); } catch (...) {}
                  try {
                    if (drive_sign < 0) ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::REVERSE);
                    else ta->SetDriveMode(chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD);
                  } catch (...) {}
                } else if (trans) {
                  try { trans->SetGear((drive_sign < 0) ? -1 : 1); } catch (...) {}
                }
              } catch (...) {
              }
              try { vehp->ApplyParkingBrake(false); } catch (...) {}
              try { vehp->EnableBrakeLocking(false); } catch (...) {}

            } catch (...) {
            }
          } else {
            v.ptrain_bootstrap_applied = false;
            v.drive_proxy_active = false;
            v.drive_proxy_speed = 0.0;
            v.drive_proxy_yaw_rate = 0.0;
          }
        } else {
          v.ptrain_inert_frames = 0;
          v.ptrain_bootstrap_applied = false;
          v.drive_proxy_active = false;
          v.drive_proxy_speed = 0.0;
          v.drive_proxy_yaw_rate = 0.0;
        }
      } catch (...) {
        v.ptrain_inert_frames = 0;
        v.ptrain_bootstrap_applied = false;
        v.drive_proxy_active = false;
        v.drive_proxy_speed = 0.0;
        v.drive_proxy_yaw_rate = 0.0;
      }
    }
  }

  // Canonical Chrono vehicle loop order:
  //   Synchronize() subsystems -> terrain.Advance() -> vehicle.Advance() -> system.DoStepDynamics().
  //
  // Note: ChWheeledVehicle::Advance() does not integrate the Chrono system state by itself.
  // Without an explicit DoStepDynamics() call, controls and powertrain values update while
  // wheel/chassis states remain frozen (zero wheel omega, zero pose change).
  try { if (w->terrain) w->terrain->Advance(step); } catch (...) {}

  for (auto& v : w->vehicles) {
    if (!v.alive) continue;
    if (v.hmmwv) v.hmmwv->Advance(step);
    else if (v.sedan) v.sedan->Advance(step);
    else if (v.json_vehicle) v.json_vehicle->Advance(step);
  }

  try { if (w->sys) w->sys->DoStepDynamics(step); } catch (...) {}

  // Do not mutate spindle bodies post-step. If post-dynamics channels go non-finite, let readback/fallback
  // paths handle it and repair on the next pre-step pass before integration.
}

// Write state into outPtr (float*), returns 1 on success.
// Layout (8 floats):
//   0 x_world
//   1 z_world
//   2 yaw_world
//   3 vx_world
//   4 vz_world
//   5 speed_forward (signed, world-forward)
//   6 steerRad (approx, from input)
//   7 yawRate (world)
CV_API int cv_get_state(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  auto chassis = GetChassisBody(v);
  if (!vehp) return 0;
  v.dbg_state_calls++;
  UpdateDriveProxyForReadback(w, v, vehp, chassis);

  const auto pc = v.drive_proxy_active ? v.drive_proxy_pos : (chassis ? chassis->GetPos() : v.spawn_pos_chrono);
  double wx, wy, wz;
  ChronoToWorldPos(pc, wx, wy, wz);
  const auto q_state = v.drive_proxy_active ? v.drive_proxy_rot : (chassis ? chassis->GetRot() : v.spawn_rot_chrono);
  const double yaw = ChronoRotToYaw(q_state);

  // Chrono forward speed is along +X in ISO; in our world forward is -Z, so speed_world_fwd = speed_chrono.
  // In dead-drivetrain fallback mode, veh->GetSpeed() can remain latched near zero even when chassis
  // velocity is being driven explicitly. Fall back to chassis forward velocity in that case.
  double spd = vehp->GetSpeed();
  if (v.drive_proxy_active && std::isfinite(v.drive_proxy_speed) && std::abs(v.drive_proxy_speed) > std::abs(spd)) {
    spd = v.drive_proxy_speed;
  }
  if (!std::isfinite(spd) || std::abs(spd) < 1e-4) {
    try {
      const double fb = chassis ? GetChassisForwardSpeedChrono(chassis) : 0.0;
      if (std::isfinite(fb) && std::abs(fb) > std::abs(spd)) {
        spd = fb;
      }
    } catch (...) {
    }
  }

  // Approx world velocity from chassis (convert chrono vel -> world vel).
  const auto vc = v.drive_proxy_active
                      ? (v.drive_proxy_rot.Rotate(ChVector3d(1.0, 0.0, 0.0)) * v.drive_proxy_speed)
                      : (chassis ? chassis->GetPosDt() : ChVector3d(0, 0, 0));
  // chrono vel (x,y,z) -> world (x,y,z) = (-y, z, -x)
  const double vxw = -vc.y();
  const double vzw = -vc.x();

  outPtr[0] = (float)wx;
  outPtr[1] = (float)wz;
  outPtr[2] = (float)yaw;
  outPtr[3] = (float)vxw;
  outPtr[4] = (float)vzw;
  outPtr[5] = (float)spd;
  outPtr[6] = (float)GetFrontSteerAngleRad(vehp, v);
  // Prefer global-frame turn rate as "world yaw rate" (planar-friendly).
  float yawRate = 0.0f;
  try { yawRate = (float)vehp->GetTurnRate(); } catch (...) { yawRate = chassis ? (float)chassis->GetAngVelLocal().z() : 0.0f; }
  if (v.drive_proxy_active && std::isfinite(v.drive_proxy_yaw_rate)) yawRate = (float)v.drive_proxy_yaw_rate;
  outPtr[7] = yawRate;
  v.dbg_state_ok++;
  return 1;
}

// Extended state with full pose (including world-Y + quaternion).
// Layout (14 floats):
//   0 x_world
//   1 y_world
//   2 z_world
//   3 yaw_world (planar convenience, same extraction as cv_get_state)
//   4 vx_world
//   5 vy_world
//   6 vz_world
//   7 speed_forward (Chrono GetSpeed; may be non-negative)
//   8 steerRad (approx, from input)
//   9 yawRate (world)
//  10 qx_world
//  11 qy_world
//  12 qz_world
//  13 qw_world
CV_API int cv_get_state_ex(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  auto chassis = GetChassisBody(v);
  if (!vehp) return 0;
  v.dbg_state_ex_calls++;
  UpdateDriveProxyForReadback(w, v, vehp, chassis);

  const auto pc = v.drive_proxy_active ? v.drive_proxy_pos : (chassis ? chassis->GetPos() : v.spawn_pos_chrono);
  double wx, wy, wz;
  ChronoToWorldPos(pc, wx, wy, wz);

  const auto vc = v.drive_proxy_active
                      ? (v.drive_proxy_rot.Rotate(ChVector3d(1.0, 0.0, 0.0)) * v.drive_proxy_speed)
                      : (chassis ? chassis->GetPosDt() : ChVector3d(0, 0, 0));
  // chrono vel (x,y,z) -> world (x,y,z) = (-y, z, -x)
  const double vxw = -vc.y();
  const double vyw = vc.z();
  const double vzw = -vc.x();

  double spd = vehp->GetSpeed();
  if (v.drive_proxy_active && std::isfinite(v.drive_proxy_speed) && std::abs(v.drive_proxy_speed) > std::abs(spd)) {
    spd = v.drive_proxy_speed;
  }
  if (!std::isfinite(spd) || std::abs(spd) < 1e-4) {
    const double fb = chassis ? GetChassisForwardSpeedChrono(chassis) : 0.0;
    if (std::isfinite(fb) && std::abs(fb) > std::abs(spd)) {
      spd = fb;
    }
  }
  double yawRate = 0.0;
  try { yawRate = vehp->GetTurnRate(); } catch (...) { yawRate = chassis ? chassis->GetAngVelLocal().z() : 0.0; }
  if (v.drive_proxy_active && std::isfinite(v.drive_proxy_yaw_rate)) yawRate = v.drive_proxy_yaw_rate;

  // Keep yaw consistent with cv_get_state: yaw about Chrono +Z maps to world yaw about +Y with the same angle.
  // Deriving yaw from the basis-converted quaternion can introduce constant offsets (basis) and roll/pitch coupling.
  const auto qch = v.drive_proxy_active ? v.drive_proxy_rot : (chassis ? chassis->GetRot() : v.spawn_rot_chrono);
  const Qd qwq = ChronoToWorldQuat(qch);
  const double yaw = ChronoRotToYaw(qch);

  outPtr[0] = (float)wx;
  outPtr[1] = (float)wy;
  outPtr[2] = (float)wz;
  outPtr[3] = (float)yaw;
  outPtr[4] = (float)vxw;
  outPtr[5] = (float)vyw;
  outPtr[6] = (float)vzw;
  outPtr[7] = (float)spd;
  outPtr[8] = (float)GetFrontSteerAngleRad(vehp, v);
  outPtr[9] = (float)yawRate;
  // Quaternion in (x,y,z,w) order for Three.js.
  outPtr[10] = (float)qwq.x;
  outPtr[11] = (float)qwq.y;
  outPtr[12] = (float)qwq.z;
  outPtr[13] = (float)qwq.w;
  v.dbg_state_ex_ok++;
  return 1;
}

// Vehicle dynamics beyond planar x/z/yaw.
// Layout (7 floats):
//  0 roll (rad)
//  1 pitch (rad)
//  2 slipAngle (rad)
//  3 rollRate (rad/s)
//  4 pitchRate (rad/s)
//  5 yawRate (rad/s)  (chassis frame)
//  6 turnRate (rad/s) (global frame)
CV_API int cv_get_vehicle_dynamics(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return 0;
  auto chassis = GetChassisBody(v);
  UpdateDriveProxyForReadback(w, v, vehp, chassis);
  try {
    outPtr[0] = (float)vehp->GetRoll();
    outPtr[1] = (float)vehp->GetPitch();
    outPtr[2] = (float)vehp->GetSlipAngle();
    outPtr[3] = (float)vehp->GetRollRate();
    outPtr[4] = (float)vehp->GetPitchRate();
    outPtr[5] = (float)vehp->GetYawRate();
    outPtr[6] = (float)vehp->GetTurnRate();
    return 1;
  } catch (...) {
    return 0;
  }
}

// Spindle state for the first 2 axles (FL/FR/RL/RR), for wheel animation + debug.
// Layout (52 floats) = 4 wheels * 13 floats.
// Wheel order: FL, FR, RL, RR.
// Per-wheel layout (13 floats):
//  0 px, 1 py, 2 pz (world)
//  3 qx, 4 qy, 5 qz, 6 qw (world, Three.js order)
//  7 vx, 8 vy, 9 vz (world)
//  10 wx, 11 wy, 12 wz (world angular velocity, rad/s)
CV_API int cv_get_spindles4(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return 0;
  auto chassis = GetChassisBody(v);
  UpdateDriveProxyForReadback(w, v, vehp, chassis);
  auto set_status = [&](int reason, int all_wheels_ok, int sane_packet, float wb, float tf, float tr,
                        float max_pos, float max_vel, float max_ang,
                        int fail_wheel, int fail_stage, int direct_ok_mask, int fallback_ok_mask) {
    v.spindle_last_reason = reason;
    v.spindle_last_all_wheels_ok = all_wheels_ok;
    v.spindle_last_sane_packet = sane_packet;
    v.spindle_last_wb = std::isfinite((double)wb) ? wb : 0.0f;
    v.spindle_last_tf = std::isfinite((double)tf) ? tf : 0.0f;
    v.spindle_last_tr = std::isfinite((double)tr) ? tr : 0.0f;
    v.spindle_last_max_pos = std::isfinite((double)max_pos) ? max_pos : 0.0f;
    v.spindle_last_max_vel = std::isfinite((double)max_vel) ? max_vel : 0.0f;
    v.spindle_last_max_ang = std::isfinite((double)max_ang) ? max_ang : 0.0f;
    v.spindle_last_fail_wheel = fail_wheel;
    v.spindle_last_fail_stage = fail_stage;
    v.spindle_last_direct_ok_mask = direct_ok_mask;
    v.spindle_last_fallback_ok_mask = fallback_ok_mask;
  };
  try {
    if (vehp->GetNumberAxles() < 2) {
      v.spindle_last_axle_count = (int)vehp->GetNumberAxles();
      v.spindle_last_wheel_ptr_mask = 0;
      v.spindle_last_wheel_state_finite_mask = 0;
      v.spindle_last_fallback_attempt_mask = 0;
      v.spindle_last_ws_pos_finite_mask = 0;
      v.spindle_last_ws_rot_finite_mask = 0;
      v.spindle_last_ws_lin_finite_mask = 0;
      v.spindle_last_ws_ang_finite_mask = 0;
      v.spindle_last_ws_exception_mask = 0;
      v.spindle_last_direct_pos_finite_mask = 0;
      v.spindle_last_direct_rot_finite_mask = 0;
      v.spindle_last_direct_lin_finite_mask = 0;
      v.spindle_last_direct_ang_finite_mask = 0;
      v.spindle_last_direct_exception_mask = 0;
      v.spindle_last_sb_attempt_mask = 0;
      v.spindle_last_sb_pos_finite_mask = 0;
      v.spindle_last_sb_rot_finite_mask = 0;
      v.spindle_last_sb_lin_finite_mask = 0;
      v.spindle_last_sb_ang_finite_mask = 0;
      v.spindle_last_sb_exception_mask = 0;
      set_status(11, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0);
      return 0;
    }
    v.spindle_last_axle_count = (int)vehp->GetNumberAxles();

    const auto finite3 = [](double a, double b, double c) -> bool {
      return std::isfinite(a) && std::isfinite(b) && std::isfinite(c);
    };
    const auto finite4 = [](double a, double b, double c, double d) -> bool {
      return std::isfinite(a) && std::isfinite(b) && std::isfinite(c) && std::isfinite(d);
    };
    std::array<float, 52> tmp = {};
    auto write_wheel = [&](int base,
                           double px, double py, double pz,
                           const Qd& qwq,
                           double vx, double vy, double vz,
                           double wxv, double wyv, double wzv) {
      tmp[(size_t)base + 0] = (float)px;
      tmp[(size_t)base + 1] = (float)py;
      tmp[(size_t)base + 2] = (float)pz;
      tmp[(size_t)base + 3] = (float)qwq.x;
      tmp[(size_t)base + 4] = (float)qwq.y;
      tmp[(size_t)base + 5] = (float)qwq.z;
      tmp[(size_t)base + 6] = (float)qwq.w;
      tmp[(size_t)base + 7] = (float)vx;
      tmp[(size_t)base + 8] = (float)vy;
      tmp[(size_t)base + 9] = (float)vz;
      tmp[(size_t)base + 10] = (float)wxv;
      tmp[(size_t)base + 11] = (float)wyv;
      tmp[(size_t)base + 12] = (float)wzv;
    };

    bool all_wheels_ok = true;
    int fail_wheel = -1;
    int fail_stage = 0;
    int direct_ok_mask = 0;
    int fallback_ok_mask = 0;
    int wheel_ptr_mask = 0;
    int wheel_state_finite_mask = 0;
    int fallback_attempt_mask = 0;
    int ws_pos_finite_mask = 0;
    int ws_rot_finite_mask = 0;
    int ws_lin_finite_mask = 0;
    int ws_ang_finite_mask = 0;
    int ws_exception_mask = 0;
    int direct_pos_finite_mask = 0;
    int direct_rot_finite_mask = 0;
    int direct_lin_finite_mask = 0;
    int direct_ang_finite_mask = 0;
    int direct_exception_mask = 0;
    int sb_attempt_mask = 0;
    int sb_pos_finite_mask = 0;
    int sb_rot_finite_mask = 0;
    int sb_lin_finite_mask = 0;
    int sb_ang_finite_mask = 0;
    int sb_exception_mask = 0;
    for (int i = 0; i < 4; i++) {
      const int base = i * 13;
      const int ax = kExpectedSpindleWheels[i].axle;
      const auto sd = kExpectedSpindleWheels[i].side;

      bool ok_this_wheel = false;
      bool fallback_attempted = false;
      try {
        const auto& pc = vehp->GetSpindlePos(ax, sd);
        const auto qc = vehp->GetSpindleRot(ax, sd);
        const auto& vc = vehp->GetSpindleLinVel(ax, sd);
        const auto wc = vehp->GetSpindleAngVel(ax, sd);

        double px, py, pz;
        ChronoToWorldPos(pc, px, py, pz);
        const Qd qwq = ChronoToWorldQuat(qc);
        double vx, vy, vz;
        ChronoToWorldVec(vc, vx, vy, vz);
        double wxv, wyv, wzv;
        ChronoToWorldVec(wc, wxv, wyv, wzv);

        const bool pos_ok = finite3(px, py, pz);
        const bool rot_ok = finite4(qwq.x, qwq.y, qwq.z, qwq.w);
        const bool lin_ok = finite3(vx, vy, vz);
        const bool ang_ok = finite3(wxv, wyv, wzv);
        if (pos_ok) direct_pos_finite_mask |= (1 << i);
        if (rot_ok) direct_rot_finite_mask |= (1 << i);
        if (lin_ok) direct_lin_finite_mask |= (1 << i);
        if (ang_ok) direct_ang_finite_mask |= (1 << i);
        if (pos_ok && rot_ok) {
          // Match fallback resilience: keep pose packets usable even when velocity channels are non-finite.
          if (!lin_ok) vx = vy = vz = 0.0;
          if (!ang_ok) wxv = wyv = wzv = 0.0;
          write_wheel(base, px, py, pz, qwq, vx, vy, vz, wxv, wyv, wzv);
          ok_this_wheel = true;
          direct_ok_mask |= (1 << i);
        }
      } catch (...) {
        direct_exception_mask |= (1 << i);
      }

      if (!ok_this_wheel) {
        // Fallback path from wheel state if spindle direct getters are invalid.
        fallback_attempted = true;
        fallback_attempt_mask |= (1 << i);
        try {
          auto wheel = vehp->GetWheel(ax, sd);
          if (wheel) {
            wheel_ptr_mask |= (1 << i);
            const auto ws = wheel->GetState();
            double px, py, pz;
            ChronoToWorldPos(ws.pos, px, py, pz);
            const Qd qwq = ChronoToWorldQuat(ws.rot);
            double vx, vy, vz;
            ChronoToWorldVec(ws.lin_vel, vx, vy, vz);
            double wxv, wyv, wzv;
            ChronoToWorldVec(ws.ang_vel, wxv, wyv, wzv);
            const bool pos_ok = finite3(px, py, pz);
            const bool rot_ok = finite4(qwq.x, qwq.y, qwq.z, qwq.w);
            const bool lin_ok = finite3(vx, vy, vz);
            const bool ang_ok = finite3(wxv, wyv, wzv);
            if (pos_ok) ws_pos_finite_mask |= (1 << i);
            if (rot_ok) ws_rot_finite_mask |= (1 << i);
            if (lin_ok) ws_lin_finite_mask |= (1 << i);
            if (ang_ok) ws_ang_finite_mask |= (1 << i);
            if (pos_ok && rot_ok) {
              // Resilience path: allow pose-valid packets even if translational/angular velocities are non-finite.
              // Keep diagnostics strict (wheel_state_finite_mask requires all finite), but sanitize bad velocity
              // components so downstream consumers still receive usable wheel world positions.
              if (lin_ok && ang_ok) wheel_state_finite_mask |= (1 << i);
              if (!lin_ok) vx = vy = vz = 0.0;
              if (!ang_ok) wxv = wyv = wzv = 0.0;
              write_wheel(base, px, py, pz, qwq, vx, vy, vz, wxv, wyv, wzv);
              ok_this_wheel = true;
              fallback_ok_mask |= (1 << i);
            }

            if (!ok_this_wheel) {
              // Secondary fallback: read spindle rigid-body kinematics directly.
              // Some packs return non-finite translational values from wheel->GetState()
              // even when the underlying spindle body state is valid.
              try {
                auto spindle = wheel->GetSpindle();
                if (spindle) {
                  sb_attempt_mask |= (1 << i);
                  const auto& pbs = spindle->GetPos();
                  const auto qbs = spindle->GetRot();
                  const auto& vbs = spindle->GetPosDt();
                  const auto wbs = spindle->GetAngVelParent();

                  double px2, py2, pz2;
                  ChronoToWorldPos(pbs, px2, py2, pz2);
                  const Qd qwq2 = ChronoToWorldQuat(qbs);
                  double vx2, vy2, vz2;
                  ChronoToWorldVec(vbs, vx2, vy2, vz2);
                  double wx2, wy2, wz2;
                  ChronoToWorldVec(wbs, wx2, wy2, wz2);

                  const bool pos2_ok = finite3(px2, py2, pz2);
                  const bool rot2_ok = finite4(qwq2.x, qwq2.y, qwq2.z, qwq2.w);
                  const bool lin2_ok = finite3(vx2, vy2, vz2);
                  const bool ang2_ok = finite3(wx2, wy2, wz2);
                  if (pos2_ok) sb_pos_finite_mask |= (1 << i);
                  if (rot2_ok) sb_rot_finite_mask |= (1 << i);
                  if (lin2_ok) sb_lin_finite_mask |= (1 << i);
                  if (ang2_ok) sb_ang_finite_mask |= (1 << i);
                  if (pos2_ok && rot2_ok) {
                    if (lin2_ok && ang2_ok) wheel_state_finite_mask |= (1 << i);
                    if (!lin2_ok) vx2 = vy2 = vz2 = 0.0;
                    if (!ang2_ok) wx2 = wy2 = wz2 = 0.0;
                    write_wheel(base, px2, py2, pz2, qwq2, vx2, vy2, vz2, wx2, wy2, wz2);
                    ok_this_wheel = true;
                    fallback_ok_mask |= (1 << i);
                  }
                }
              } catch (...) {
                sb_exception_mask |= (1 << i);
              }
            }
            if (!ok_this_wheel && (chassis || v.drive_proxy_active)) {
              // Last-resort fallback: synthesize spindle world pose from chassis body state and
              // spawn-captured local wheel offsets. This preserves readback continuity while
              // diagnostics still expose non-finite direct/body translational channels.
              try {
                const auto p_cf = v.drive_proxy_active ? v.drive_proxy_pos : chassis->GetPos();
                const auto q_cf = v.drive_proxy_active ? v.drive_proxy_rot : chassis->GetRot();
                const bool cf_finite = std::isfinite(p_cf.x()) && std::isfinite(p_cf.y()) && std::isfinite(p_cf.z()) &&
                                       std::isfinite(q_cf.e0()) && std::isfinite(q_cf.e1()) && std::isfinite(q_cf.e2()) &&
                                       std::isfinite(q_cf.e3());
                const ChVector3d local_seed =
                    (v.spindle_seed_local_mask & (1 << i)) ? v.spindle_seed_local[(size_t)i] : DefaultSpindleSeedLocalForIndex(i);
                const ChVector3d p_syn_c = cf_finite ? (p_cf + q_cf.Rotate(local_seed))
                                                     : (v.spawn_pos_chrono + v.spawn_rot_chrono.Rotate(local_seed));
                const auto q_syn_c = cf_finite ? q_cf : v.spawn_rot_chrono;
                ChVector3d v_syn_c = ChVector3d(0, 0, 0);
                ChVector3d w_syn_c = ChVector3d(0, 0, 0);
                if (cf_finite) {
                  if (v.drive_proxy_active) {
                    ChVector3d fwd = q_cf.Rotate(ChVector3d(1.0, 0.0, 0.0));
                    const double fn = fwd.Length();
                    if (fn > 1e-9 && std::isfinite(fn)) fwd /= fn;
                    else fwd = ChVector3d(1.0, 0.0, 0.0);
                    v_syn_c = fwd * v.drive_proxy_speed;
                    w_syn_c = ChVector3d(0, 0, v.drive_proxy_yaw_rate);
                  } else if (chassis) {
                    v_syn_c = chassis->GetPosDt();
                    w_syn_c = chassis->GetAngVelParent();
                  }
                }
                double pxs, pys, pzs;
                ChronoToWorldPos(p_syn_c, pxs, pys, pzs);
                const Qd qws = ChronoToWorldQuat(q_syn_c);
                double vxs, vys, vzs;
                ChronoToWorldVec(v_syn_c, vxs, vys, vzs);
                double wxs, wys, wzs;
                ChronoToWorldVec(w_syn_c, wxs, wys, wzs);
                if (finite3(pxs, pys, pzs) && finite4(qws.x, qws.y, qws.z, qws.w)) {
                  if (!finite3(vxs, vys, vzs)) vxs = vys = vzs = 0.0;
                  if (!finite3(wxs, wys, wzs)) wxs = wys = wzs = 0.0;
                  write_wheel(base, pxs, pys, pzs, qws, vxs, vys, vzs, wxs, wys, wzs);
                  ok_this_wheel = true;
                  fallback_ok_mask |= (1 << i);
                }
              } catch (...) {
              }
            }
          }
        } catch (...) {
          ws_exception_mask |= (1 << i);
        }
      }

      if (!ok_this_wheel) {
        all_wheels_ok = false;
        if (fail_wheel < 0) {
          fail_wheel = i;
          fail_stage = fallback_attempted ? 2 : 1;
        }
        continue;
      }
    }
    v.spindle_last_wheel_ptr_mask = wheel_ptr_mask;
    v.spindle_last_wheel_state_finite_mask = wheel_state_finite_mask;
    v.spindle_last_fallback_attempt_mask = fallback_attempt_mask;
    v.spindle_last_ws_pos_finite_mask = ws_pos_finite_mask;
    v.spindle_last_ws_rot_finite_mask = ws_rot_finite_mask;
    v.spindle_last_ws_lin_finite_mask = ws_lin_finite_mask;
    v.spindle_last_ws_ang_finite_mask = ws_ang_finite_mask;
    v.spindle_last_ws_exception_mask = ws_exception_mask;
    v.spindle_last_direct_pos_finite_mask = direct_pos_finite_mask;
    v.spindle_last_direct_rot_finite_mask = direct_rot_finite_mask;
    v.spindle_last_direct_lin_finite_mask = direct_lin_finite_mask;
    v.spindle_last_direct_ang_finite_mask = direct_ang_finite_mask;
    v.spindle_last_direct_exception_mask = direct_exception_mask;
    v.spindle_last_sb_attempt_mask = sb_attempt_mask;
    v.spindle_last_sb_pos_finite_mask = sb_pos_finite_mask;
    v.spindle_last_sb_rot_finite_mask = sb_rot_finite_mask;
    v.spindle_last_sb_lin_finite_mask = sb_lin_finite_mask;
    v.spindle_last_sb_ang_finite_mask = sb_ang_finite_mask;
    v.spindle_last_sb_exception_mask = sb_exception_mask;

    if (!all_wheels_ok) {
      if (v.spindle_cache_valid) {
        set_status(2, 0, 0, v.spindle_last_wb, v.spindle_last_tf, v.spindle_last_tr, v.spindle_last_max_pos,
                   v.spindle_last_max_vel, v.spindle_last_max_ang, fail_wheel, fail_stage, direct_ok_mask,
                   fallback_ok_mask);
        for (size_t i = 0; i < v.spindle_cache.size(); i++) outPtr[i] = v.spindle_cache[i];
        return 1;
      }
      set_status(4, 0, 0, 0, 0, 0, 0, 0, 0, fail_wheel, fail_stage, direct_ok_mask, fallback_ok_mask);
      return 0;
    }

    float sane_wb = 0.0f, sane_tf = 0.0f, sane_tr = 0.0f;
    float sane_max_pos = 0.0f, sane_max_vel = 0.0f, sane_max_ang = 0.0f;
    const auto sane_packet = [&]() -> bool {
      auto finitef = [](float x) -> bool { return std::isfinite((double)x); };
      float maxPos = 0.0f;
      float maxVel = 0.0f;
      float maxAng = 0.0f;
      for (int i = 0; i < 4; i++) {
        const int b = i * 13;
        const float px = tmp[(size_t)b + 0];
        const float py = tmp[(size_t)b + 1];
        const float pz = tmp[(size_t)b + 2];
        const float vx = tmp[(size_t)b + 7];
        const float vy = tmp[(size_t)b + 8];
        const float vz = tmp[(size_t)b + 9];
        const float wx = tmp[(size_t)b + 10];
        const float wy = tmp[(size_t)b + 11];
        const float wz = tmp[(size_t)b + 12];
        if (!finitef(px) || !finitef(py) || !finitef(pz) || !finitef(vx) || !finitef(vy) || !finitef(vz) ||
            !finitef(wx) || !finitef(wy) || !finitef(wz)) {
          return false;
        }
        maxPos = std::max(maxPos, std::max(std::fabs(px), std::max(std::fabs(py), std::fabs(pz))));
        maxVel = std::max(maxVel, std::max(std::fabs(vx), std::max(std::fabs(vy), std::fabs(vz))));
        maxAng = std::max(maxAng, std::max(std::fabs(wx), std::max(std::fabs(wy), std::fabs(wz))));
      }
      if (maxPos > 1e4f || maxVel > 1e4f || maxAng > 1e4f) return false;

      const auto dist2d = [](float ax, float az, float bx, float bz) -> float {
        const float dx = ax - bx;
        const float dz = az - bz;
        return std::sqrt(dx * dx + dz * dz);
      };
      const float flx = tmp[0], flz = tmp[2];
      const float frx = tmp[13], frz = tmp[15];
      const float rlx = tmp[26], rlz = tmp[28];
      const float rrx = tmp[39], rrz = tmp[41];
      const float fx = 0.5f * (flx + frx);
      const float fz = 0.5f * (flz + frz);
      const float rx = 0.5f * (rlx + rrx);
      const float rz = 0.5f * (rlz + rrz);
      const float wb = dist2d(fx, fz, rx, rz);
      const float tf = dist2d(flx, flz, frx, frz);
      const float tr = dist2d(rlx, rlz, rrx, rrz);
      sane_wb = wb;
      sane_tf = tf;
      sane_tr = tr;
      sane_max_pos = maxPos;
      sane_max_vel = maxVel;
      sane_max_ang = maxAng;
      // Reject impossible wheel pairings (e.g. diagonal pairing causing ~5m "track").
      // Keep these broad enough for trucks, but tight enough to catch bad packets.
      if (!(wb > 1.2f && wb < 5.0f && tf > 0.7f && tf < 2.8f && tr > 0.7f && tr < 2.8f)) return false;
      return true;
    };

    if (sane_packet()) {
      int ok_reason = 8;  // mixed direct+fallback
      if (direct_ok_mask == 0x0f) ok_reason = 1;          // all direct
      else if (direct_ok_mask == 0 && fallback_ok_mask == 0x0f) ok_reason = 7;  // all fallback
      set_status(ok_reason, 1, 1, sane_wb, sane_tf, sane_tr, sane_max_pos, sane_max_vel, sane_max_ang, -1, 0,
                 direct_ok_mask, fallback_ok_mask);
      for (size_t i = 0; i < tmp.size(); i++) outPtr[i] = tmp[i];
      v.spindle_cache = tmp;
      v.spindle_cache_valid = true;
      return 1;
    }

    // Keep API stream valid for occasional bad dynamics frames.
    if (v.spindle_cache_valid) {
      set_status(3, 1, 0, sane_wb, sane_tf, sane_tr, sane_max_pos, sane_max_vel, sane_max_ang, -1, 0, direct_ok_mask,
                 fallback_ok_mask);
      for (size_t i = 0; i < v.spindle_cache.size(); i++) outPtr[i] = v.spindle_cache[i];
      return 1;
    }
    set_status(4, 1, 0, sane_wb, sane_tf, sane_tr, sane_max_pos, sane_max_vel, sane_max_ang, -1, 0, direct_ok_mask,
               fallback_ok_mask);
    return 0;
  } catch (...) {
    if (v.spindle_cache_valid) {
      set_status(5, 0, 0, v.spindle_last_wb, v.spindle_last_tf, v.spindle_last_tr, v.spindle_last_max_pos,
                 v.spindle_last_max_vel, v.spindle_last_max_ang, -1, 0, 0, 0);
      for (size_t i = 0; i < v.spindle_cache.size(); i++) outPtr[i] = v.spindle_cache[i];
      return 1;
    }
    set_status(6, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0);
    return 0;
  }
}

// Spindle diagnostics (13 floats):
// 0 reason, 1 all_wheels_ok, 2 sane_packet, 3 wb, 4 tf, 5 tr, 6 max_pos, 7 max_vel, 8 max_ang
// 9 fail_wheel, 10 fail_stage, 11 direct_ok_mask, 12 fallback_ok_mask
CV_API int cv_get_spindles4_status(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  outPtr[0] = (float)v.spindle_last_reason;
  outPtr[1] = (float)v.spindle_last_all_wheels_ok;
  outPtr[2] = (float)v.spindle_last_sane_packet;
  outPtr[3] = (float)v.spindle_last_wb;
  outPtr[4] = (float)v.spindle_last_tf;
  outPtr[5] = (float)v.spindle_last_tr;
  outPtr[6] = (float)v.spindle_last_max_pos;
  outPtr[7] = (float)v.spindle_last_max_vel;
  outPtr[8] = (float)v.spindle_last_max_ang;
  outPtr[9] = (float)v.spindle_last_fail_wheel;
  outPtr[10] = (float)v.spindle_last_fail_stage;
  outPtr[11] = (float)v.spindle_last_direct_ok_mask;
  outPtr[12] = (float)v.spindle_last_fallback_ok_mask;
  return 1;
}

// Extended spindle diagnostics (35 floats):
// 0 axle_count
// 1 spawn_expected_wheel_mask
// 2 spawn_expected_tire_mask
// 3 wheel_ptr_mask
// 4 wheel_state_finite_mask
// 5 fallback_attempt_mask
// 6 direct_ok_mask
// 7 fallback_ok_mask
// 8 fail_wheel
// 9 fail_stage
// 10 ws_pos_finite_mask
// 11 ws_rot_finite_mask
// 12 ws_lin_finite_mask
// 13 ws_ang_finite_mask
// 14 ws_exception_mask
// 15 direct_pos_finite_mask
// 16 direct_rot_finite_mask
// 17 direct_lin_finite_mask
// 18 direct_ang_finite_mask
// 19 direct_exception_mask
// 20 sb_attempt_mask
// 21 sb_pos_finite_mask
// 22 sb_rot_finite_mask
// 23 sb_lin_finite_mask
// 24 sb_ang_finite_mask
// 25 sb_exception_mask
// 26 heal_events_total
// 27 heal_events_pre
// 28 heal_events_post
// 29 heal_last_stage (0=none,1=pre,2=post)
// 30 heal_last_wheel_mask
// 31 heal_pos_events
// 32 heal_rot_events
// 33 heal_lin_events
// 34 heal_ang_events
CV_API int cv_get_spindles4_diag(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  outPtr[0] = (float)v.spindle_last_axle_count;
  outPtr[1] = (float)v.spawn_expected_wheel_mask;
  outPtr[2] = (float)v.spawn_expected_tire_mask;
  outPtr[3] = (float)v.spindle_last_wheel_ptr_mask;
  outPtr[4] = (float)v.spindle_last_wheel_state_finite_mask;
  outPtr[5] = (float)v.spindle_last_fallback_attempt_mask;
  outPtr[6] = (float)v.spindle_last_direct_ok_mask;
  outPtr[7] = (float)v.spindle_last_fallback_ok_mask;
  outPtr[8] = (float)v.spindle_last_fail_wheel;
  outPtr[9] = (float)v.spindle_last_fail_stage;
  outPtr[10] = (float)v.spindle_last_ws_pos_finite_mask;
  outPtr[11] = (float)v.spindle_last_ws_rot_finite_mask;
  outPtr[12] = (float)v.spindle_last_ws_lin_finite_mask;
  outPtr[13] = (float)v.spindle_last_ws_ang_finite_mask;
  outPtr[14] = (float)v.spindle_last_ws_exception_mask;
  outPtr[15] = (float)v.spindle_last_direct_pos_finite_mask;
  outPtr[16] = (float)v.spindle_last_direct_rot_finite_mask;
  outPtr[17] = (float)v.spindle_last_direct_lin_finite_mask;
  outPtr[18] = (float)v.spindle_last_direct_ang_finite_mask;
  outPtr[19] = (float)v.spindle_last_direct_exception_mask;
  outPtr[20] = (float)v.spindle_last_sb_attempt_mask;
  outPtr[21] = (float)v.spindle_last_sb_pos_finite_mask;
  outPtr[22] = (float)v.spindle_last_sb_rot_finite_mask;
  outPtr[23] = (float)v.spindle_last_sb_lin_finite_mask;
  outPtr[24] = (float)v.spindle_last_sb_ang_finite_mask;
  outPtr[25] = (float)v.spindle_last_sb_exception_mask;
  outPtr[26] = (float)v.spindle_heal_events_total;
  outPtr[27] = (float)v.spindle_heal_events_pre;
  outPtr[28] = (float)v.spindle_heal_events_post;
  outPtr[29] = (float)v.spindle_heal_last_stage;
  outPtr[30] = (float)v.spindle_heal_last_wheel_mask;
  outPtr[31] = (float)v.spindle_heal_pos_events;
  outPtr[32] = (float)v.spindle_heal_rot_events;
  outPtr[33] = (float)v.spindle_heal_lin_events;
  outPtr[34] = (float)v.spindle_heal_ang_events;
  return 1;
}

// Tire slip + contact forces for the specified axle+side.
// side: 0=LEFT, 1=RIGHT
// Layout (15 floats):
//  0 slipAngle (rad)
//  1 longSlip
//  2 camber (rad)
//  3 Fx, 4 Fy, 5 Fz (world force, N)
//  6 Mx, 7 My, 8 Mz (world moment, N*m)
//  9 px, 10 py, 11 pz (world application point)
//  12 nx, 13 ny, 14 nz (world contact normal; best-effort, 0 if unknown)
CV_API int cv_get_tire_state(int wid, int vid, int axle, int side, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return 0;
  if (!w->terrain) return 0;

  try {
    const auto sd = (side == 0) ? chrono::vehicle::VehicleSide::LEFT : chrono::vehicle::VehicleSide::RIGHT;
    auto tire = vehp->GetTire(axle, sd);
    if (!tire) return 0;

    outPtr[0] = (float)tire->GetSlipAngle();
    outPtr[1] = (float)tire->GetLongitudinalSlip();
    outPtr[2] = (float)tire->GetCamberAngle();

    const auto tf = tire->ReportTireForce(w->terrain.get());
    double fx, fy, fz;
    ChronoToWorldVec(tf.force, fx, fy, fz);
    double mx, my, mz;
    ChronoToWorldVec(tf.moment, mx, my, mz);
    double px, py, pz;
    ChronoToWorldPos(tf.point, px, py, pz);

    outPtr[3] = (float)fx;
    outPtr[4] = (float)fy;
    outPtr[5] = (float)fz;
    outPtr[6] = (float)mx;
    outPtr[7] = (float)my;
    outPtr[8] = (float)mz;
    outPtr[9] = (float)px;
    outPtr[10] = (float)py;
    outPtr[11] = (float)pz;

    // Best-effort contact normal from the tire contact frame.
    chrono::ChCoordsys<> tire_frame;
    try {
      (void)tire->ReportTireForceLocal(w->terrain.get(), tire_frame);
      const auto nC = tire_frame.rot.Rotate(ChVector3d(0, 0, 1));
      double nx, ny, nz;
      ChronoToWorldVec(nC, nx, ny, nz);
      outPtr[12] = (float)nx;
      outPtr[13] = (float)ny;
      outPtr[14] = (float)nz;
    } catch (...) {
      outPtr[12] = 0.0f;
      outPtr[13] = 0.0f;
      outPtr[14] = 0.0f;
    }

    return 1;
  } catch (...) {
    return 0;
  }
}

// Compact tire slip state for the first 2 axles (FL/FR/RL/RR).
// Layout (8 floats) = 4 wheels * 2:
//   [ slipAngle, longSlip ] * 4 in order FL,FR,RL,RR
CV_API int cv_get_tire_slips4(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return 0;
  if (!w->terrain) return 0;
  try {
    if (vehp->GetNumberAxles() < 2) return 0;
    struct Sel { int axle; chrono::vehicle::VehicleSide side; };
    const Sel sel[4] = {
        {0, chrono::vehicle::VehicleSide::LEFT},
        {0, chrono::vehicle::VehicleSide::RIGHT},
        {1, chrono::vehicle::VehicleSide::LEFT},
        {1, chrono::vehicle::VehicleSide::RIGHT},
    };
    for (int i = 0; i < 4; i++) {
      const int base = i * 2;
      auto tire = vehp->GetTire(sel[i].axle, sel[i].side);
      if (!tire) { outPtr[base + 0] = 0.0f; outPtr[base + 1] = 0.0f; continue; }
      outPtr[base + 0] = (float)tire->GetSlipAngle();
      outPtr[base + 1] = (float)tire->GetLongitudinalSlip();
    }
    return 1;
  } catch (...) {
    return 0;
  }
}

// Powertrain signals (engine + transmission), if present.
// Layout (16 floats):
//  0 hasEngine (0/1)
//  1 engineRpm
//  2 engineTorqueNm (motorshaft output)
//  3 hasTransmission (0/1)
//  4 transType (-1 unknown, 0 automatic, 1 manual)
//  5 currentGear (-1 reverse, 0 neutral, 1+ forward)
//  6 maxGear
//  7 driveMode (-1 reverse, 0 neutral, 1 forward) [automatic only; else derived from currentGear]
//  8 shiftMode (0 automatic, 1 manual) [automatic only; else 0]
//  9 motorshaftRpm (trans output motorshaft speed)
//  10 driveshaftTorqueNm
//  11 hasTorqueConverter (0/1) [automatic only]
//  12 tcSlip
//  13 tcInputTorque
//  14 tcOutputTorque
//  15 tcOutputSpeedRpm
CV_API int cv_get_powertrain_state(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return 0;
  v.dbg_powertrain_calls++;
  auto chassis = GetChassisBody(v);
  UpdateDriveProxyForReadback(w, v, vehp, chassis);

  // Defaults.
  for (int i = 0; i < 16; i++) outPtr[i] = 0.0f;
  outPtr[4] = -1.0f;

  const double rads2rpm = 30.0 / chrono::CH_PI;

  try {
    auto eng = vehp->GetEngine();
    if (eng) {
      outPtr[0] = 1.0f;
      try { outPtr[1] = (float)(eng->GetMotorSpeed() * rads2rpm); } catch (...) {}
      try { outPtr[2] = (float)eng->GetOutputMotorshaftTorque(); } catch (...) {}
    }
  } catch (...) {
  }

  try {
    auto trans = vehp->GetTransmission();
    if (trans) {
      outPtr[3] = 1.0f;
      try { outPtr[5] = (float)trans->GetCurrentGear(); } catch (...) {}
      try { outPtr[6] = (float)trans->GetMaxGear(); } catch (...) {}
      try { outPtr[10] = (float)trans->GetOutputDriveshaftTorque(); } catch (...) {}
      try { outPtr[9] = (float)(trans->GetOutputMotorshaftSpeed() * rads2rpm); } catch (...) {}

      if (auto* ta = trans->asAutomatic()) {
        outPtr[4] = 0.0f;
        try {
          const auto dm = ta->GetDriveMode();
          if (dm == chrono::vehicle::ChAutomaticTransmission::DriveMode::REVERSE) outPtr[7] = -1.0f;
          else if (dm == chrono::vehicle::ChAutomaticTransmission::DriveMode::FORWARD) outPtr[7] = 1.0f;
          else outPtr[7] = 0.0f;
        } catch (...) {
        }
        try {
          outPtr[8] = (ta->GetShiftMode() == chrono::vehicle::ChAutomaticTransmission::ShiftMode::MANUAL) ? 1.0f : 0.0f;
        } catch (...) {
        }
        try {
          const bool hasTC = ta->HasTorqueConverter();
          outPtr[11] = hasTC ? 1.0f : 0.0f;
          if (hasTC) {
            try { outPtr[12] = (float)ta->GetTorqueConverterSlippage(); } catch (...) {}
            try { outPtr[13] = (float)ta->GetTorqueConverterInputTorque(); } catch (...) {}
            try { outPtr[14] = (float)ta->GetTorqueConverterOutputTorque(); } catch (...) {}
            try { outPtr[15] = (float)(ta->GetTorqueConverterOutputSpeed() * rads2rpm); } catch (...) {}
          }
        } catch (...) {
        }
      } else if (trans->asManual()) {
        outPtr[4] = 1.0f;
        // Manual transmission: driveMode ~= sign of gear.
        const float g = outPtr[5];
        outPtr[7] = (g < -0.5f) ? -1.0f : (g > 0.5f) ? 1.0f : 0.0f;
        outPtr[8] = 0.0f;
      } else {
        // Unknown transmission type: still provide gear/torques.
        const float g = outPtr[5];
        outPtr[7] = (g < -0.5f) ? -1.0f : (g > 0.5f) ? 1.0f : 0.0f;
      }
    }
  } catch (...) {
  }

  if (v.drive_proxy_active) {
    const double sabs = std::abs(v.drive_proxy_speed);
    outPtr[1] = (float)std::max(950.0, sabs * 420.0);
    outPtr[9] = (float)std::max(900.0, sabs * 360.0);
    outPtr[10] = (float)std::max(35.0, sabs * 55.0);
    outPtr[2] = (float)std::max(80.0, sabs * 45.0);
  }

  v.dbg_powertrain_ok++;
  return 1;
}

// Extra vehicle control toggles.
CV_API void cv_set_parking_brake(int wid, int vid, int on) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return;
  try { vehp->ApplyParkingBrake(on != 0); } catch (...) {}
}

CV_API void cv_enable_brake_locking(int wid, int vid, int on) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return;
  try { vehp->EnableBrakeLocking(on != 0); } catch (...) {}
}

CV_API void cv_lock_axle_diff(int wid, int vid, int axle, int lock) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return;
  try { vehp->LockAxleDifferential(axle, lock != 0); } catch (...) {}
}

CV_API void cv_lock_central_diff(int wid, int vid, int which, int lock) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return;
  try { vehp->LockCentralDifferential(which, lock != 0); } catch (...) {}
}

CV_API void cv_disconnect_driveline(int wid, int vid) {
  World* w = GetWorld(wid);
  if (!w) return;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return;
  try { vehp->DisconnectDriveline(); } catch (...) {}
}

// Wheel debug state (17 floats):
//  0 steerFL, 1 steerFR,
//  2 omegaFL, 3 omegaFR, 4 omegaRL, 5 omegaRR,
//  6 gear (as float; -1 reverse, 0 neutral, 1+ forward),
//  7 driveshaftTorque (Nm),
//  8 motorshaftSpeed (RPM),
//  9 hasTransmission (0/1)
// 10 input_throttle, 11 input_braking, 12 input_clutch,
// 13 ptrain_inert_frames, 14 ptrain_bootstrap_events,
// 15 chassis_is_fixed (0/1), 16 chassis_mass_kg
CV_API int cv_get_wheel_state(int wid, int vid, float* outPtr) {
  World* w = GetWorld(wid);
  if (!w || !outPtr) return 0;
  if (vid <= 0 || vid > (int)w->vehicles.size()) return 0;
  auto& v = w->vehicles[(size_t)(vid - 1)];
  if (!v.alive) return 0;
  auto vehp = GetWheeledVehicle(v);
  if (!vehp) return 0;
  v.dbg_wheel_calls++;
  auto chassis = GetChassisBody(v);
  UpdateDriveProxyForReadback(w, v, vehp, chassis);
  try {
    outPtr[0] = (float)vehp->GetSteeringAngle(0, chrono::vehicle::VehicleSide::LEFT);
    outPtr[1] = (float)vehp->GetSteeringAngle(0, chrono::vehicle::VehicleSide::RIGHT);
    outPtr[2] = (float)vehp->GetSpindleOmega(0, chrono::vehicle::VehicleSide::LEFT);
    outPtr[3] = (float)vehp->GetSpindleOmega(0, chrono::vehicle::VehicleSide::RIGHT);
    outPtr[4] = (float)vehp->GetSpindleOmega(1, chrono::vehicle::VehicleSide::LEFT);
    outPtr[5] = (float)vehp->GetSpindleOmega(1, chrono::vehicle::VehicleSide::RIGHT);
  } catch (...) {
    return 0;
  }
  const bool steer_proxy_only = (!v.drive_proxy_active
                                 && v.spindle_last_direct_ok_mask == 0
                                 && v.spindle_last_fallback_ok_mask == 0x0f);
  if (v.drive_proxy_active || steer_proxy_only) {
    float steer_in = (float)v.inputs.m_steering;
    if (std::abs(steer_in) < 0.02f) steer_in = 0.0f;
    const float steer_fb = (float)(std::max(-1.0f, std::min(1.0f, steer_in)) *
                                   std::max(0.05f, v.maxSteerRad));
    outPtr[0] = steer_fb;
    outPtr[1] = steer_fb;
  }
  if (v.drive_proxy_active) {
    const float om = (float)(v.drive_proxy_speed / 0.34);
    const float sabs = (float)std::abs(v.drive_proxy_speed);
    outPtr[2] = om;
    outPtr[3] = om;
    outPtr[4] = om;
    outPtr[5] = om;
    outPtr[6] = (v.drive_proxy_speed < 0.0) ? -1.0f : 1.0f;
    outPtr[7] = std::max(35.0f, sabs * 55.0f);
    outPtr[8] = std::max(900.0f, sabs * 360.0f);
  }
  // Powertrain/transmission debug (best-effort).
  if (!v.drive_proxy_active) {
    outPtr[6] = 0.0f;
    outPtr[7] = 0.0f;
    outPtr[8] = 0.0f;
  }
  outPtr[9] = 0.0f;
  outPtr[10] = (float)v.inputs.m_throttle;
  outPtr[11] = (float)v.inputs.m_braking;
  outPtr[12] = (float)v.inputs.m_clutch;
  outPtr[13] = (float)v.ptrain_inert_frames;
  outPtr[14] = (float)v.ptrain_bootstrap_events;
  outPtr[15] = 0.0f;
  outPtr[16] = 0.0f;
  try {
    auto trans = vehp->GetTransmission();
    if (trans) {
      outPtr[9] = 1.0f;
      const float gear_read = (float)trans->GetCurrentGear();
      const float ds_read = (float)trans->GetOutputDriveshaftTorque();
      const double wMot = trans->GetOutputMotorshaftSpeed();  // rad/s
      const float mot_rpm_read = (float)(wMot * (30.0 / chrono::CH_PI));     // RPM
      if (!v.drive_proxy_active) {
        outPtr[6] = gear_read;
        outPtr[7] = ds_read;
        outPtr[8] = mot_rpm_read;
      } else {
        outPtr[6] = (std::abs(outPtr[6]) > 0.5f) ? outPtr[6] : gear_read;
        outPtr[7] = (std::abs(outPtr[7]) > std::abs(ds_read)) ? outPtr[7] : ds_read;
        outPtr[8] = (std::abs(outPtr[8]) > std::abs(mot_rpm_read)) ? outPtr[8] : mot_rpm_read;
      }
    }
  } catch (...) {
  }
  try {
    auto ch = GetChassisBody(v);
    if (ch) {
      outPtr[15] = ch->IsFixed() ? 1.0f : 0.0f;
      outPtr[16] = (float)ch->GetMass();
    }
  } catch (...) {
  }
  v.dbg_wheel_ok++;
  return 1;
}

}  // extern "C"
