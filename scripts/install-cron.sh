#!/bin/bash

# CASCA Editorial Agent - Install Daily Scheduler
# This script installs a launchd agent that retries hourly until one article is sent each day.

set -e

echo "🚀 Installing CASCA Editorial Agent scheduler..."
echo ""

# Get the project directory (parent of scripts/)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_FILE="$PROJECT_DIR/com.casca.daily-workflow.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/com.casca.daily-workflow.plist"

# Check if plist file exists
if [ ! -f "$PLIST_FILE" ]; then
    echo "❌ Error: plist file not found at $PLIST_FILE"
    exit 1
fi

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p "$PROJECT_DIR/logs/daily"
mkdir -p "$PROJECT_DIR/logs"

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload existing agent if it's already loaded
if [ -f "$INSTALLED_PLIST" ]; then
    echo "🔄 Unloading existing agent..."
    launchctl bootout "gui/$(id -u)" "$INSTALLED_PLIST" 2>/dev/null || true
fi

# Copy plist file to LaunchAgents
echo "📋 Installing launch agent..."
cp "$PLIST_FILE" "$INSTALLED_PLIST"

# Set proper permissions
chmod 644 "$INSTALLED_PLIST"

# Load the agent
echo "✅ Loading launch agent..."
launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST"

echo ""
echo "✅ Installation complete!"
echo ""
echo "📅 The CASCA Editorial Agent will now retry every hour until one article is successfully sent for the local day."
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
echo "  launchctl bootout gui/\$(id -u) $INSTALLED_PLIST"
echo ""
echo "  Reload (after changes):"
echo "  launchctl bootout gui/\$(id -u) $INSTALLED_PLIST && launchctl bootstrap gui/\$(id -u) $INSTALLED_PLIST"
echo ""
echo "  Test run manually:"
echo "  cd $PROJECT_DIR && npm run daily"
echo ""
echo "  Test with dry-run:"
echo "  cd $PROJECT_DIR && npm run daily -- --dry-run"
echo ""

exit 0
