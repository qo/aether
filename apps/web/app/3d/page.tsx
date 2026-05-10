"use client";

import dynamic from "next/dynamic";

// Three.js is huge and SSR-incompatible — load only on the client.
const ThreeDPage = dynamic(() => import("../../features/three-d/three-d-page"), { ssr: false });

export default function ThreeDRoute() {
  return <ThreeDPage />;
}
