"use client";

import dynamic from "next/dynamic";

// raw-sensor.tsx pulls in uPlot/heavy widgets at module init — keep it
// dynamic-only so the rest of the app doesn't pay for it.
const RawSensorPage = dynamic(() => import("../../features/raw-sensor"), { ssr: false });

export default function RawRoute() {
  return <RawSensorPage />;
}
