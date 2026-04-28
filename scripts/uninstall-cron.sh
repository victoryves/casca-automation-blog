#!/bin/bash

# CASCA Editorial Agent - Uninstall Daily Cron Job

set -e

echo "🗑️  Uninstalling CASCA Editorial Agent daily scheduler..."
echo ""

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLISTS=(
  "com.casca.daily-workflow.plist"
  "com.casca.research-miner.plist"
  "com.casca.scout-agent.plist"
  "com.casca.curator-agent.plist"
)

FOUND=0
for plist in "${PLISTS[@]}"; do
    INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/$plist"
    if [ ! -f "$INSTALLED_PLIST" ]; then
        continue
    fi
    FOUND=1
    echo "🔄 Unloading $plist..."
    launchctl bootout "gui/$(id -u)" "$INSTALLED_PLIST" 2>/dev/null || true
    echo "🗑️  Removing $plist..."
    rm "$INSTALLED_PLIST"
done

if [ "$FOUND" -eq 0 ]; then
    echo "⚠️  No CASCA worker plists found. Nothing to uninstall."
    exit 0
fi

echo ""
echo "✅ Uninstallation complete!"
echo ""
echo "The CASCA Editorial Agent daily scheduler has been removed."
echo "Note: Log files have been preserved in the logs/ directory."
echo ""

exit 0
