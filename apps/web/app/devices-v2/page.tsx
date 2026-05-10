"use client";

import dynamic from "next/dynamic";

const DevicesV2Page = dynamic(() => import("../../features/devices-v2"), { ssr: false });

export default function DevicesV2Route() {
  return <DevicesV2Page />;
}
