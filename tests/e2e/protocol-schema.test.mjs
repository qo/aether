import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const schemaDir = join(root, "packages", "protocol", "schemas");

function readSchema(name) {
  return JSON.parse(readFileSync(join(schemaDir, name), "utf8"));
}

const csi = readSchema("csi_frame.schema.json");
const derived = readSchema("derived_window.schema.json");
const event = readSchema("experiment_event.schema.json");

assert.equal(csi.properties.schema_version.const, "csi_frame.v1");
assert.equal(derived.properties.schema_version.const, "derived_window.v1");
assert.equal(event.properties.schema_version.const, "experiment_event.v1");

for (const schema of [csi, derived, event]) {
  assert.deepEqual(schema.properties.source_mode.enum, ["LIVE", "REPLAY"]);
  assert.equal(schema.additionalProperties, false);
}

for (const field of ["raw_iq_int8", "payload_len", "rssi_dbm", "ts_host_ns"]) {
  assert.ok(csi.required.includes(field), `csi schema missing ${field}`);
}

for (const field of ["motion_score", "occupancy_score", "quality_score", "source_mode"]) {
  assert.ok(derived.required.includes(field), `derived schema missing ${field}`);
}

console.log("Protocol schemas passed smoke validation.");
