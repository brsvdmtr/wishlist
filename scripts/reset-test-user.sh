#!/usr/bin/env bash
# reset-test-user.sh
# Resets a test user to a clean state for share-prompt manual testing.
#
# Usage:
#   ./scripts/reset-test-user.sh [TELEGRAM_ID]
#
# Default TELEGRAM_ID: 8747175307
#
# What it does:
#   1. Resets firstWishSharePromptShown = false
#   2. Resets readyWishlistSharePromptShown = false
#   3. Soft-deletes all real (non-demo) items in REGULAR wishlists
#   4. Prints final state for confirmation

set -euo pipefail

TG_ID="${1:-8747175307}"

PSQL="docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist"

echo "==> Resetting test user telegramId=$TG_ID"

# 1. Get user id
USER_ID=$(ssh timeweb "$PSQL -tAc \"SELECT id FROM \\\"User\\\" WHERE \\\"telegramId\\\" = '$TG_ID';\"")

if [ -z "$USER_ID" ]; then
  echo "ERROR: user with telegramId=$TG_ID not found"
  exit 1
fi

echo "    user.id = $USER_ID"

# 2. Reset both share prompt flags
ssh timeweb "$PSQL -c \"
  UPDATE \\\"UserProfile\\\"
  SET
    \\\"firstWishSharePromptShown\\\" = false,
    \\\"readyWishlistSharePromptShown\\\" = false
  WHERE \\\"userId\\\" = '$USER_ID';
\""
echo "    firstWishSharePromptShown = false ✓"
echo "    readyWishlistSharePromptShown = false ✓"

# 3. Soft-delete all real REGULAR items
ssh timeweb "$PSQL -c \"
  UPDATE \\\"Item\\\" SET status = 'DELETED'
  WHERE \\\"wishlistId\\\" IN (
    SELECT id FROM \\\"Wishlist\\\"
    WHERE \\\"ownerId\\\" = '$USER_ID' AND type = 'REGULAR'
  )
  AND \\\"isDemo\\\" = false
  AND status != 'DELETED';
\""
echo "    real REGULAR items soft-deleted ✓"

# 4. Print final state
echo ""
echo "==> Final state"
echo ""
echo "--- UserProfile ---"
ssh timeweb "$PSQL -c \"
  SELECT \\\"firstWishSharePromptShown\\\", \\\"readyWishlistSharePromptShown\\\"
  FROM \\\"UserProfile\\\" WHERE \\\"userId\\\" = '$USER_ID';
\""

echo "--- Wishlists ---"
ssh timeweb "$PSQL -c \"
  SELECT id, title, type, \\\"createdAt\\\"
  FROM \\\"Wishlist\\\" WHERE \\\"ownerId\\\" = '$USER_ID'
  ORDER BY \\\"createdAt\\\";
\""

echo "--- Real REGULAR items (should be 0) ---"
ssh timeweb "$PSQL -c \"
  SELECT count(*) AS remaining_real_items
  FROM \\\"Item\\\" i
  JOIN \\\"Wishlist\\\" w ON w.id = i.\\\"wishlistId\\\"
  WHERE w.\\\"ownerId\\\" = '$USER_ID'
    AND w.type = 'REGULAR'
    AND i.\\\"isDemo\\\" = false
    AND i.status != 'DELETED';
\""

echo ""
echo "✅ Ready for manual test."
echo "   Item #1 → first-share full-screen prompt"
echo "   Item #2 → ready-share bottom sheet"
