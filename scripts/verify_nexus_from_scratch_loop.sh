#!/usr/bin/env bash
# Verification loop for the from-scratch Nexus model.
# Prints PASS/FAIL per step and exits non-zero on any failure.
# Usage:  bash scripts/verify_nexus_from_scratch_loop.sh
set -u
URL="${NEXUS_MODEL_URL:-http://127.0.0.1:4500}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
step() { printf "\n[%s] %s\n" "$1" "$2"; }
pass() { echo "  PASS: $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }

step 1 "Model server reachable ($URL/health)"
HEALTH="$(curl -s --max-time 5 "$URL/health" || true)"
if echo "$HEALTH" | grep -q '"ok": *true'; then pass "health responds"; echo "  $HEALTH"
else bad "health endpoint not responding — start it: cd nexus-model && python serve.py"; fi

step 2 "Checkpoint metadata"
if echo "$HEALTH" | grep -q '"model_loaded": *true'; then pass "checkpoint loaded"
else bad "no checkpoint loaded (model needs training)"; fi

step 3 "Chat endpoint returns a non-empty reply"
REPLY="$(curl -s --max-time 60 -X POST "$URL/chat" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello Nexus, are you working?"}]}' || true)"
if echo "$REPLY" | grep -q '"reply"'; then pass "chat responded"; else bad "chat endpoint failed"; fi
LEN=$(echo "$REPLY" | python -c "import sys,json; print(len((json.load(sys.stdin).get('reply') or '').strip()))" 2>/dev/null || echo 0)
if [ "${LEN:-0}" -ge 10 ]; then pass "reply non-empty ($LEN chars)"; else bad "reply empty/too short"; fi

step 4 "Quality eval (eval_quality.py — coherence gate)"
if ( cd "$ROOT/nexus-model" && python eval_quality.py ); then pass "quality eval PASSED"
else bad "quality eval FAILED (output not coherent enough yet)"; fi

step 5 "Frontend build passes"
if ( cd "$ROOT" && npm --prefix client run build >/tmp/nexus_fe_build.log 2>&1 ); then pass "client build OK"
else bad "client build failed (see /tmp/nexus_fe_build.log)"; fi

step 6 "Frontend points at the Nexus model"
if grep -Rqs "nexus" "$ROOT/shared/models.js"; then pass "nexus model registered in dropdown"
else bad "nexus model not found in shared/models.js"; fi

echo
if [ "$fail" -eq 0 ]; then echo "==== VERIFY: ALL PASS ===="; exit 0
else echo "==== VERIFY: FAILURES ABOVE ===="; exit 1; fi
