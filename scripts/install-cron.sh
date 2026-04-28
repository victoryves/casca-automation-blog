#!/bin/bash

# CASCA Editorial Agent - Install Daily Scheduler
# This script installs a launchd agent that retries hourly until one article is sent each day.

set -e

echo "🚀 Installing CASCA Editorial Agent scheduler..."
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLISTS=(
  "com.casca.daily-workflow.plist"
  "com.casca.research-miner.plist"
  "com.casca.scout-agent.plist"
  "com.casca.curator-agent.plist"
)

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p "$PROJECT_DIR/logs/daily"
mkdir -p "$PROJECT_DIR/logs"

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$LAUNCH_AGENTS_DIR"

for plist in "${PLISTS[@]}"; do
    PLIST_FILE="$PROJECT_DIR/$plist"
    INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/$plist"

    if [ ! -f "$PLIST_FILE" ]; then
        echo "❌ Error: plist file not found at $PLIST_FILE"
        exit 1
    fi

    if [ -f "$INSTALLED_PLIST" ]; then
        echo "🔄 Unloading existing agent $plist..."
        launchctl bootout "gui/$(id -u)" "$INSTALLED_PLIST" 2>/dev/null || true
    fi

    echo "📋 Installing $plist..."
    cp "$PLIST_FILE" "$INSTALLED_PLIST"
    chmod 644 "$INSTALLED_PLIST"
    echo "✅ Loading $plist..."
    launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST"
done

echo ""
echo "✅ Installation complete!"
echo ""
echo "📅 The CASCA Editorial Agent worker topology is now installed."
echo ""
echo "📊 Useful commands:"
echo ""
echo "  Check status:"
echo "  launchctl list | grep casca"
echo ""
echo "  View logs:"
echo "  tail -f $PROJECT_DIR/logs/launchd-stdout.log"
echo "  tail -f $PROJECT_DIR/logs/daily/\$(date +%Y-%m-%d).log"
echo ""
echo "  Unload (disable):"
echo "  launchctl list | grep casca"
echo ""
echo "  Reload (after changes):"
echo "  ./scripts/install-cron.sh"
echo ""
echo "  Test run manually:"
echo "  cd $PROJECT_DIR && npm run dispatcher -- --force"
echo ""

exit 0
