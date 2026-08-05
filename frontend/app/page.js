"use client";

import MissionControl from "../components/MissionControl";

// The standalone "/" route. All mission control logic now lives in
// components/MissionControl.jsx so it can also be embedded as a tab
// inside the Team Workspace (app/workspace/page.js) without duplicating
// 1,200+ lines of gamepad/telemetry/detection logic across two files.
export default function Page() {
  return <MissionControl />;
}