#!/bin/bash

# CASCA Editorial Agent - Install Webhook Server (launchd)
# Keeps the local webhook server alive across reboots.

set -e

echo "🚀 Installing CASCA webhook server..."
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_FILE="$PROJECT_DIR/com.casca.webhook-server.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/com.casca.webhook-server.plist"

if [ ! -f "$PLIST_FILE" ]; then
    echo "❌ Error: plist file not found at $PLIST_FILE"
    exit 1
fi

mkdir -p "$PROJECT_DIR/logs"
mkdir -p "$LAUNCH_AGENTS_DIR"

if [ -f "$INSTALLED_PLIST" ]; then
    echo "🔄 Unloading existing webhook agent..."
    launchctl bootout "gui/$(id -u)" "$INSTALLED_PLIST" 2>/dev/null || true
fi

echo "📋 Installing webhook launch agent..."
cp "$PLIST_FILE" "$INSTALLED_PLIST"
chmod 644 "$INSTALLED_PLIST"

echo "✅ Loading webhook launch agent..."
launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST"

echo ""
echo "✅ Webhook server installed!"
echo ""
echo "📊 Useful commands:"
echo "  Check status:"
echo "  launchctl list | grep casca.webhook"
echo ""
echo "  View logs:"
echo "  tail -f $PROJECT_DIR/logs/webhooks-stdout.log"
echo "  tail -f $PROJECT_DIR/logs/webhooks-watchdog.log"
echo ""
echo "  Unload (disable):"
echo "  launchctl bootout gui/$(id -u) $INSTALLED_PLIST"
echo ""

exit 0
