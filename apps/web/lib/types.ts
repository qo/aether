export type SourceMode = "LIVE" | "REPLAY";

export interface DerivedWindow {
  schema_version: "derived_window.v1";
  session_id: string;
  device_id: string;
  window_start_ns: number;
  window_end_ns: number;
  packet_count: number;
  packet_rate_hz: number;
  mean_rssi_dbm: number;
  subcarrier_count: number;
  amplitude_mean: number[];
  amplitude_std: number[];
  phase_unwrapped_mean: number[];
  phase_unwrapped_std?: number[] | null;
  motion_score_amplitude?: number | null;
  motion_score_phase?: number | null;
  responsive_subcarriers?: number[];
  motion_score: number;
  occupancy_score: number;
  respiration_bpm: number | null;
  respiration_confidence: number | null;
  respiration_bpm_acf?: number | null;
  respiration_harmonic_prominence?: number | null;
  respiration_tracked_bpm?: number | null;
  heart_rate_proxy_bpm: number | null;
  heart_rate_proxy_confidence: number | null;
  heart_rate_proxy_bpm_acf?: number | null;
  heart_rate_proxy_harmonic_prominence?: number | null;
  heart_rate_proxy_tracked_bpm?: number | null;
  fidget_score: number | null;
  gait_score?: number | null;
  gait_steps_per_min?: number | null;
  biorhythm_window_seconds: number | null;
  biorhythm_sample_rate_hz: number | null;
  biorhythm_signal_path?: string | null;
  stillness_gated?: boolean;
  looks_like_respiration_harmonic?: boolean;
  anomaly_score: number;
  quality_score: number;
  packet_loss_ratio?: number | null;
  first_word_invalid_ratio?: number | null;
  jitter_ms?: number | null;
  expected_packet_rate_hz?: number | null;
  baseline_calibrated?: boolean;
  source_mode: SourceMode;
}

export interface CalibrationStatus {
  is_calibrated: boolean;
  is_calibrating: boolean;
  frames_observed: number;
  subcarrier_count: number;
  target_seconds: number;
  progress: number;
  last_rejection_reason?: string | null;
  accepted?: boolean;
  // Item 8.3: post-calibration drift detection. drift_score is RMS-relative
  // amplitude divergence from baseline (0 = no drift); drift_detected is
  // true once enough still samples have been gathered AND drift exceeds
  // the warn threshold.
  drift_score?: number;
  drift_samples?: number;
  drift_detected?: boolean;
}

export interface RoomGeometry {
  schema_version: "room_geometry.v1";
  room_extent_m: [number, number, number] | null;
  tx_position_m: [number, number, number] | null;
  rx_position_m: [number, number, number] | null;
  tx_orientation_deg: number;
  rx_orientation_deg: number;
  subject_position_m?: [number, number, number] | null;
  subject_radius_m: number;
  notes?: string | null;
  updated_ns: number;
  /**
   * True once room + TX + RX positions are populated. The 3D view refuses
   * to render until this is true; partial geometry surfaces a setup prompt.
   */
  is_complete?: boolean;
  /**
   * Distance estimated from RSSI via the indoor log-distance path-loss
   * model (n=3). Indoor multipath makes this very rough (±50% typical).
   * Sanity check vs operator-entered TX-RX separation. ``null`` when no
   * frames have arrived.
   */
  rssi_implied_distance_m?: number | null;
}

export interface LinkDiagnostics {
  schema_version: "link_diagnostics.v1";
  /** null when no frames have been seen yet (vs 0 which would be a measurement). */
  observed_packet_rate_hz: number | null;
  expected_packet_rate_hz: number;
  expected_rate_source: string;
  inter_arrival_p50_ms: number | null;
  inter_arrival_p90_ms: number | null;
  inter_arrival_p99_ms: number | null;
  inter_arrival_max_ms: number | null;
  inter_arrival_jitter_ms: number | null;
  rssi_p50_dbm: number | null;
  rssi_std_dbm: number | null;
  noise_floor_p50_dbm: number | null;
  first_word_invalid_ratio: number;
  frames_seen: number;
  firmware_packets_seen: number | null;
  firmware_dropped: number | null;
  firmware_queue_depth: number | null;
  rate_stable: boolean;
  last_frame_age_s: number | null;
  rssi_implied_distance_m?: number | null;
  notes: string[];
}

export interface SubcarrierDiagnostics {
  schema_version: "subcarrier_diagnostics.v1";
  is_calibrated: boolean;
  subcarrier_count: number;
  edges_dropped: number;
  kept_indices?: number[];
  responsive_indices: number[];
  amplitude_mean: number[];
  amplitude_std: number[];
  snr_weights: number[];
}

export interface RawFrame {
  schema_version: "csi_frame.v1";
  session_id: string;
  device_id: string;
  device_role: "rx";
  seq: number;
  ts_device_us: number;
  ts_host_ns: number;
  channel: number;
  rssi_dbm: number;
  noise_floor_dbm: number;
  sig_mode: number;
  cwb: number;
  secondary_channel: number;
  stbc: number;
  first_word_invalid: boolean;
  payload_len: number;
  raw_iq_int8: number[];
  source_mode: SourceMode;
}

export interface RawFrameMessage {
  type: "raw_frame";
  frame: RawFrame;
  derived: {
    amplitude: number[];
    phase: number[];
    subcarrier_count: number;
  };
}

export interface RoomSummary {
  schema_version: string;
  status?: string;
  session_id?: string;
  source_mode?: SourceMode;
  timestamp_ns?: number;
  quality_score?: number;
  confidence?: number;
  occupancy?: string;
  motion?: string;
  measured?: Record<string, number | null>;
  diagnostics?: {
    packet_loss_ratio?: number | null;
    first_word_invalid_ratio?: number | null;
    jitter_ms?: number | null;
    baseline_calibrated?: boolean;
  };
  calibration?: CalibrationStatus;
  unknowns?: string[];
}

export interface LiveMessage {
  type: "hello" | "derived_window" | "raw_frame" | "subscribed";
  window?: DerivedWindow;
  summary?: RoomSummary;
  frame?: RawFrame;
  derived?: {
    amplitude: number[];
    phase: number[];
    subcarrier_count: number;
  };
  topics?: string[];
  available_topics?: string[];
}

export interface SessionRecord {
  session_id: string;
  source_mode: SourceMode;
  protocol: string;
  notes?: string | null;
  consent?: string;
  started_ns?: number | null;
  stopped_ns?: number | null;
  created_ns: number;
}

export interface ExperimentEvent {
  schema_version: "experiment_event.v1";
  session_id: string;
  event_id: string;
  event_type: string;
  ts_host_ns: number;
  source_mode: SourceMode;
  label?: string | null;
  notes?: string | null;
}
