#!/bin/bash

# CASCA Editorial Agent - Uninstall Daily Cron Job

set -e

echo "🗑️  Uninstalling CASCA Editorial Agent daily scheduler..."
echo ""

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/com.casca.daily-workflow.plist"

# Check if plist exists
if [ ! -f "$INSTALLED_PLIST" ]; then
    echo "⚠️  Launch agent not found. Nothing to uninstall."
    exit 0
fi

# Unload the agent
echo "🔄 Unloading launch agent..."
launchctl unload "$INSTALLED_PLIST" 2>/dev/null || true

# Remove the plist file
echo "🗑️  Removing launch agent file..."
rm "$INSTALLED_PLIST"

echo ""
echo "✅ Uninstallation complete!"
echo ""
echo "The CASCA Editorial Agent daily scheduler has been removed."
echo "Note: Log files have been preserved in the logs/ directory."
echo ""

exit 0
