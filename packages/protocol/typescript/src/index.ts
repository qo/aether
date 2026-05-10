export type SourceMode = "LIVE" | "REPLAY";

export interface RawCsiFrame {
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
  heart_rate_proxy_bpm?: number | null;
  heart_rate_proxy_confidence?: number | null;
  heart_rate_proxy_bpm_acf?: number | null;
  heart_rate_proxy_harmonic_prominence?: number | null;
  heart_rate_proxy_tracked_bpm?: number | null;
  fidget_score?: number | null;
  biorhythm_window_seconds?: number | null;
  biorhythm_sample_rate_hz?: number | null;
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

export interface RoomGeometry {
  schema_version: "room_geometry.v1";
  room_extent_m: [number, number, number];
  tx_position_m: [number, number, number];
  rx_position_m: [number, number, number];
  tx_orientation_deg: number;
  rx_orientation_deg: number;
  subject_position_m?: [number, number, number] | null;
  subject_radius_m: number;
  notes?: string | null;
  updated_ns: number;
}

export interface LinkDiagnostics {
  schema_version: "link_diagnostics.v1";
  observed_packet_rate_hz: number;
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

export interface ExperimentEvent {
  schema_version: "experiment_event.v1";
  session_id: string;
  event_id: string;
  event_type:
    | "session_started"
    | "session_stopped"
    | "label_added"
    | "empty_room"
    | "person_entered"
    | "person_exited"
    | "cross_los"
    | "sit_still"
    | "wave_hand"
    | "breathing_trial"
    | "distance_changed"
    | "orientation_changed";
  ts_host_ns: number;
  label?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
  source_mode: SourceMode;
}
