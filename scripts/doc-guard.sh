#!/usr/bin/env bash
set -euo pipefail

ERRORS=0

fail() {
  echo "ERROR: $1"
  ERRORS=$((ERRORS + 1))
}

echo "Running doc-guard..."

# -----------------------------
# Required docs existence
# -----------------------------
required_docs=(
  "docs/INDEX.md"
  "docs/ARCHITECTURE.md"
  "docs/DATA_MODEL.md"
  "docs/MONETIZATION.md"
  "docs/API_REFERENCE.md"
  "docs/BACKEND_MAP.md"
  "docs/TELEGRAM_FLOW.md"
  "docs/USER_FLOWS.md"
  "docs/FRONTEND_MAP.md"
  "docs/FRONTEND_API_MAP.md"
  "docs/INFRA_AND_ENV.md"
  "docs/SETTINGS_AND_PRIVACY.md"
  "docs/LINK_IMPORT.md"
  "docs/KNOWN_GAPS_AND_RISKS.md"
  "docs/CHANGELOG_DOCS.md"
  "docs/CURRENT_PRODUCT_STATE.md"
  "docs/ONBOARDING_AND_ACTIVATION.md"
  "docs/WEB_EXPANSION_AND_AUTH_MODEL.md"
  "docs/ANALYTICS_AND_GODMODE.md"
  "docs/OPERATIONS_RUNBOOK_LIGHT.md"
)

for f in "${required_docs[@]}"; do
  [[ -f "$f" ]] || fail "Missing required doc: $f"
done

# -----------------------------
# Stale patterns that must not remain
# -----------------------------
stale_patterns=(
  "49 models"
  "14 enums"
  "33 screens"
  "RU + EN"
  "Webhook / polling"
  "webhook / polling"
)

for pattern in "${stale_patterns[@]}"; do
  if grep -RIn --exclude-dir=.git -- "$pattern" docs/ > /tmp/doc_guard_match.txt; then
    echo "Found stale pattern: $pattern"
    cat /tmp/doc_guard_match.txt
    fail "Stale pattern remains in docs: $pattern"
  fi
done

# -----------------------------
# Required current truth markers
# -----------------------------
if ! grep -q "78 Prisma models, 38 enums" docs/INDEX.md; then
  fail "docs/INDEX.md does not contain updated model/enum count"
fi

if ! grep -q "78 models" docs/DATA_MODEL.md; then
  fail "docs/DATA_MODEL.md does not confirm 78 models"
fi

if ! grep -q "61 screens" docs/INDEX.md; then
  fail "docs/INDEX.md does not contain updated screen count"
fi

if ! grep -q "61 screens" docs/FRONTEND_MAP.md; then
  fail "docs/FRONTEND_MAP.md does not contain 61 screens"
fi

if ! grep -q "78 Prisma models" docs/CURRENT_PRODUCT_STATE.md; then
  fail "docs/CURRENT_PRODUCT_STATE.md does not confirm 78 Prisma models"
fi

if ! grep -q "61 screens" docs/CURRENT_PRODUCT_STATE.md; then
  fail "docs/CURRENT_PRODUCT_STATE.md does not confirm 61 screens"
fi

if ! grep -Eq "Long polling|long polling" docs/ARCHITECTURE.md; then
  fail "docs/ARCHITECTURE.md does not mention long polling"
fi

if grep -Eq "Webhook / polling|webhook / polling" docs/ARCHITECTURE.md; then
  fail "docs/ARCHITECTURE.md still contains webhook/polling wording"
fi

if ! grep -Eq "Long polling|long polling" docs/TELEGRAM_FLOW.md; then
  fail "docs/TELEGRAM_FLOW.md does not mention long polling"
fi

# -----------------------------
# Last updated: accept any YYYY-MM-DD, not hardcoded year
# -----------------------------
p0_docs=(
  "docs/INDEX.md"
  "docs/ARCHITECTURE.md"
  "docs/DATA_MODEL.md"
  "docs/MONETIZATION.md"
  "docs/API_REFERENCE.md"
  "docs/TELEGRAM_FLOW.md"
  "docs/USER_FLOWS.md"
  "docs/FRONTEND_MAP.md"
)

for f in "${p0_docs[@]}"; do
  if ! grep -Eq "(Last updated|Date):.*[0-9]{4}-[0-9]{2}-[0-9]{2}" "$f"; then
    fail "$f has missing or malformed date (expected YYYY-MM-DD)"
  fi
done

# -----------------------------
# Ensure INDEX references all required docs
# -----------------------------
index_required_refs=(
  "CHANGELOG_DOCS.md"
  "CURRENT_PRODUCT_STATE.md"
  "ONBOARDING_AND_ACTIVATION.md"
  "WEB_EXPANSION_AND_AUTH_MODEL.md"
  "ANALYTICS_AND_GODMODE.md"
  "OPERATIONS_RUNBOOK_LIGHT.md"
)

for ref in "${index_required_refs[@]}"; do
  if ! grep -q "$ref" docs/INDEX.md; then
    fail "docs/INDEX.md does not reference $ref"
  fi
done

# -----------------------------
# Locale sanity — FRONTEND_MAP must mention all 6 locales
# -----------------------------
for locale in zh-CN hi es ar; do
  if ! grep -q "$locale" docs/FRONTEND_MAP.md; then
    fail "docs/FRONTEND_MAP.md does not mention locale: $locale"
  fi
done

# -----------------------------
# Final result
# -----------------------------
echo
if [[ "$ERRORS" -gt 0 ]]; then
  echo "doc-guard FAILED with $ERRORS error(s)."
  exit 1
fi

echo "doc-guard passed."
