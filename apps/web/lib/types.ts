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
  type: "hello" | "derived_window";
  window?: DerivedWindow;
  summary?: RoomSummary;
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
