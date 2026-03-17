#!/usr/bin/env bash
# Setup script for Python Scrapling scrapers.
# Creates a virtual environment, installs dependencies, and sets up the browser.
#
# Usage: bash scripts/setup-scrapers.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SCRAPERS_DIR="$PROJECT_DIR/scrapers"
VENV_DIR="$SCRAPERS_DIR/.venv"

echo "=== CASCA Scrapers Setup ==="
echo ""

# Check for Python 3
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 is not installed."
    echo "Install it with: brew install python3 (macOS) or apt install python3 (Ubuntu)"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1)
echo "Found: $PYTHON_VERSION"

# Create virtual environment
if [ -d "$VENV_DIR" ]; then
    echo "Virtual environment already exists at $VENV_DIR"
else
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    echo "Created virtual environment at $VENV_DIR"
fi

# Activate and install dependencies
echo ""
echo "Installing dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$SCRAPERS_DIR/requirements.txt"

# Install camoufox package and browser
echo ""
echo "Installing camoufox..."
"$VENV_DIR/bin/pip" install camoufox --quiet
"$VENV_DIR/bin/python3" -m camoufox fetch || \
    echo "WARNING: Could not auto-install camoufox browser."

# Install Chromium for StealthyFetcher (patchright/playwright)
echo ""
echo "Installing Chromium browser..."
"$VENV_DIR/bin/python3" -m patchright install chromium || \
    echo "WARNING: Could not install Chromium. StealthyFetcher may not work."

# Verify installation
echo ""
echo "Verifying Scrapling installation..."
if "$VENV_DIR/bin/python3" -c "import scrapling; print(f'Scrapling {scrapling.__version__} OK')" 2>/dev/null; then
    echo "Scrapling is ready."
else
    # Try without version (some versions may not have __version__)
    if "$VENV_DIR/bin/python3" -c "import scrapling; print('Scrapling OK')" 2>/dev/null; then
        echo "Scrapling is ready."
    else
        echo "ERROR: Scrapling import failed."
        exit 1
    fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Test with:"
echo "  $VENV_DIR/bin/python3 $SCRAPERS_DIR/search_images.py \"Cícero Dias painting\" bing 3"
echo "  $VENV_DIR/bin/python3 $SCRAPERS_DIR/fetch_page.py \"https://en.wikipedia.org/wiki/Cícero_Dias\""
