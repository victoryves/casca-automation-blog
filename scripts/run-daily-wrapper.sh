#!/bin/bash

# CASCA Editorial Agent - Daily Execution Wrapper
# This script ensures proper environment setup for launchd execution

# Exit on any error
set -e

# Set the project directory
PROJECT_DIR="/Users/vicyves1/Documents/personal/Vibe Coding/casca-automation-blog"

# Change to project directory
cd "$PROJECT_DIR"

# Load environment variables
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production

# Load nvm if available (in case Node is installed via nvm)
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
fi

# Create logs directory if it doesn't exist
mkdir -p "$PROJECT_DIR/logs/daily"

# Generate log filename with timestamp
LOG_FILE="$PROJECT_DIR/logs/daily/$(date +%Y-%m-%d).log"

# Run the daily script and log output
echo "========================================" >> "$LOG_FILE"
echo "CASCA Editorial Agent - Daily Run" >> "$LOG_FILE"
echo "Started at: $(date)" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

# Execute the script (use full path to npm)
/usr/local/bin/npm run daily >> "$LOG_FILE" 2>&1

# Log completion
echo "Completed at: $(date)" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

exit 0
