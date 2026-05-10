"use client";

import { useEffect, useRef, useState } from "react";
import { connectLive, type LiveConnection } from "./api";
import type { DerivedWindow, RawFrame, RoomSummary } from "./types";

/**
 * Consume the /ws/live stream from any client component.
 *
 * - Pass `topics` to opt into raw_frame on top of the default derived_window.
 * - The hook keeps a rolling buffer of the most recent `windowBuffer` derived
 *   windows and `frameBuffer` raw frames, sized by the page's needs.
 * - Reconnects + topic re-subscription happen inside connectLive, so the hook
 *   stays declarative.
 */
export function useLiveStream(options: {
  topics?: string[];
  windowBuffer?: number;
  frameBuffer?: number;
}) {
  const { topics = ["derived_window"], windowBuffer = 160, frameBuffer = 200 } = options;
  const [status, setStatus] = useState<string>("connecting");
  const [summary, setSummary] = useState<RoomSummary | null>(null);
  const [windows, setWindows] = useState<DerivedWindow[]>([]);
  const [frames, setFrames] = useState<RawFrame[]>([]);
  // Per-frame derived amplitude/phase from the WS message (lighter than
  // recomputing from raw_iq_int8 every render).
  const [latestAmplitude, setLatestAmplitude] = useState<number[]>([]);
  const [latestPhase, setLatestPhase] = useState<number[]>([]);
  const connRef = useRef<LiveConnection | null>(null);

  useEffect(() => {
    const conn = connectLive(
      (msg) => {
        if (msg.summary) setSummary(msg.summary);
        if (msg.window) {
          setWindows((curr) => {
            const next = [...curr, msg.window as DerivedWindow];
            return next.length > windowBuffer ? next.slice(-windowBuffer) : next;
          });
        }
        if (msg.type === "raw_frame" && msg.frame) {
          setFrames((curr) => {
            const next = [...curr, msg.frame as RawFrame];
            return next.length > frameBuffer ? next.slice(-frameBuffer) : next;
          });
          if (msg.derived) {
            setLatestAmplitude(msg.derived.amplitude);
            setLatestPhase(msg.derived.phase);
          }
        }
      },
      setStatus,
      { topics }
    );
    connRef.current = conn;
    return () => conn.close();
    // intentional: topic changes happen via subscribe, not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-subscribe whenever `topics` changes by reference.
  useEffect(() => {
    connRef.current?.subscribe(topics);
  }, [topics.join("|")]);  // eslint-disable-line react-hooks/exhaustive-deps

  return { status, summary, windows, frames, latestAmplitude, latestPhase };
}
