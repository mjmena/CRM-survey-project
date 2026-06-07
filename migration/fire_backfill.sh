#!/usr/bin/env bash
# One-time backfill (issue #3): POST each unclassified poll to the taxonomy
# classification HTTP trigger SEQUENTIALLY, waiting for each to commit taxonomy
# rows before firing the next — so fetch_existing_taxonomies sees prior runs'
# paths and the "same concept = same path" consistency rule holds.
set -uo pipefail

ENDPOINT="https://eoy3u5dwjaak2ub.m.pipedream.net"
POLLS=(
  sf-generation-privacy-poll
  sf-generation-status-poll
  sf-generation-life-spice-poll
  sf-generation-fun-shift-poll
  sf-generation-competence-comeback-poll
  sf-generation-hustle-culture-poll
  crm_sports_team_survey_iam
)

taxrows() {
  snowsql -o friendly=false -o header=false -o output_format=tsv -o timing=false -q "
    SELECT COUNT(*) FROM MCC_RAW.MARKETING_DEV.DIM_SURVEY_TAXONOMY t
    JOIN MCC_RAW.MARKETING_DEV.DIM_SURVEY_OPTIONS o ON o.OPTION_ID=t.OPTION_ID
    WHERE o.POLL_ID='$1';" 2>/dev/null | tr -dc '0-9'
}

for poll in "${POLLS[@]}"; do
  echo ">>> [$(date +%H:%M:%S)] POST $poll"
  code=$(curl -s -o /tmp/bf_resp.txt -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"POLL_ID\":\"$poll\"}" "$ENDPOINT")
  echo "    HTTP $code  body=$(cat /tmp/bf_resp.txt)"
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    echo "    !! non-2xx, aborting"; exit 1
  fi
  # Poll until taxonomy rows appear (classification runs async), up to ~180s.
  ok=0
  for i in $(seq 1 18); do
    sleep 10
    n=$(taxrows "$poll"); n=${n:-0}
    echo "    [$(date +%H:%M:%S)] check $i: $n taxonomy rows"
    if [ "$n" -gt 0 ]; then ok=1; break; fi
  done
  if [ "$ok" -ne 1 ]; then
    echo "    !! $poll produced no taxonomy rows after ~180s — stopping for inspection"; exit 2
  fi
  echo "    DONE $poll ($n rows)"
done
echo ">>> ALL 7 POLLS CLASSIFIED"
