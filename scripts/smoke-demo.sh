#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${ROOT_DIR}/scripts/demo-payloads"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3001}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

pretty_json() {
  node -e 'const fs = require("fs"); const input = fs.readFileSync(0, "utf8"); try { console.log(JSON.stringify(JSON.parse(input), null, 2)); } catch { console.log(input); }'
}

post_payload_file() {
  local label="$1"
  local file="$2"
  local output_file="$3"

  echo
  echo "=== ${label} ==="
  curl -sS -X POST "${GATEWAY_URL}/max/webhook" \
    -H "content-type: application/json" \
    --data @"${file}" | tee "${output_file}" | pretty_json
}

post_inline_payload() {
  local label="$1"
  local output_file="$2"
  local payload="$3"

  echo
  echo "=== ${label} ==="
  printf '%s' "${payload}" | curl -sS -X POST "${GATEWAY_URL}/max/webhook" \
    -H "content-type: application/json" \
    --data @- | tee "${output_file}" | pretty_json
}

extract_document_id() {
  node -e '
    const fs = require("fs");
    const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const direct = response?.decision?.documentId;
    const nested = response?.decision?.forward?.result?.body?.document?.id;
    const outbound = Array.isArray(response?.outbound)
      ? response.outbound.find((message) => typeof message?.documentId === "string")?.documentId
      : undefined;
    const documentId = direct ?? nested ?? outbound;
    if (!documentId) {
      process.exit(1);
    }
    process.stdout.write(documentId);
  ' "$1"
}

render_callback_payload() {
  local template_file="$1"
  local document_id="$2"
  local output_file="$3"

  node -e '
    const fs = require("fs");
    const templatePath = process.argv[1];
    const documentId = process.argv[2];
    const outputPath = process.argv[3];
    const template = fs.readFileSync(templatePath, "utf8");
    fs.writeFileSync(outputPath, template.replace(/__DOCUMENT_ID__/g, documentId));
  ' "${template_file}" "${document_id}" "${output_file}"
}

echo "Gateway URL: ${GATEWAY_URL}"
echo "Payload dir: ${PAYLOAD_DIR}"

post_payload_file \
  "/start" \
  "${PAYLOAD_DIR}/start.json" \
  "${TMP_DIR}/start-response.json"

post_payload_file \
  "plain-text create" \
  "${PAYLOAD_DIR}/plain-text.json" \
  "${TMP_DIR}/create-response.json"

DOCUMENT_ID="$(extract_document_id "${TMP_DIR}/create-response.json")"
READY_DOCUMENT_ID="${DEMO_READY_DOCUMENT_ID:-${DOCUMENT_ID}}"

echo
echo "Created documentId: ${DOCUMENT_ID}"
if [[ "${READY_DOCUMENT_ID}" != "${DOCUMENT_ID}" ]]; then
  echo "Using DEMO_READY_DOCUMENT_ID for result/callback demo: ${READY_DOCUMENT_ID}"
else
  echo "Using created documentId for result/callback demo. If processing is not finished yet, /result and callbacks will return processing."
fi

post_inline_payload \
  "/status ${DOCUMENT_ID}" \
  "${TMP_DIR}/status-response.json" \
  "$(cat <<EOF
{"update_id":"demo-status-1","message":{"message_id":"msg-status-1","text":"/status ${DOCUMENT_ID}","chat":{"id":"chat-demo","type":"private"},"from":{"id":"user-demo","username":"demo-user","display_name":"Demo User"}}}
EOF
)"

post_inline_payload \
  "/result ${READY_DOCUMENT_ID}" \
  "${TMP_DIR}/result-response.json" \
  "$(cat <<EOF
{"update_id":"demo-result-1","message":{"message_id":"msg-result-1","text":"/result ${READY_DOCUMENT_ID}","chat":{"id":"chat-demo","type":"private"},"from":{"id":"user-demo","username":"demo-user","display_name":"Demo User"}}}
EOF
)"

render_callback_payload \
  "${PAYLOAD_DIR}/callback-detailed.json" \
  "${READY_DOCUMENT_ID}" \
  "${TMP_DIR}/callback-detailed.json"

render_callback_payload \
  "${PAYLOAD_DIR}/callback-action-items.json" \
  "${READY_DOCUMENT_ID}" \
  "${TMP_DIR}/callback-action-items.json"

post_payload_file \
  "callback detailed" \
  "${TMP_DIR}/callback-detailed.json" \
  "${TMP_DIR}/callback-detailed-response.json"

post_payload_file \
  "callback action-items" \
  "${TMP_DIR}/callback-action-items.json" \
  "${TMP_DIR}/callback-action-items-response.json"

echo
echo "Demo complete."
