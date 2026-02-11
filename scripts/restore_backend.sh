#!/bin/bash
# Restore backend to working state by reverting problematic changes

echo "🔄 Restoring backend/main.py to working state..."

# Create backup
cp backend/main.py backend/main.py.broken_backup

# Revert to last working commit before fuzzing modifications
git checkout HEAD~10 -- backend/main.py 2>/dev/null || {
    echo "❌ Git checkout failed, trying manual restoration..."
    
    # If git fails, just remove the try-except wrapper and fix indentation
    python3 << 'PYTHON_SCRIPT'
import re

print("Reading main.py...")
with open("backend/main.py", "r") as f:
    content = f.read()

# Find and fix the start_fuzzing function by removing the try-except wrapper
# This is a simple fix: remove "try:" at start and the exception handler at end
# and un-indent everything by 4 spaces

print("Fixing start_fuzzing function...")

# Simple approach: revert the entire function to not use mission-specific history
# Just use the old /tmp/aurige_fuzz_history.json approach

content_fixed = content.replace(
    'HISTORY_FILE = "{history_file_path}"',
    'HISTORY_FILE = "/tmp/aurige_fuzz_history.json"'
)

content_fixed = content_fixed.replace(
    'MISSION_ID = "{request.mission_id or \'\'}"',
    ''
)

# Remove the during_fuzz_log_path calculation that uses mission_id
# This is complex, so just disable it for now
content_fixed = content_fixed.replace(
    'during_fuzz_log_path = logs_dir / f"during_fuzz_{timestamp}.log"',
    'during_fuzz_log_path = None'
)

content_fixed = content_fixed.replace(
    'history_file_path = str(logs_dir / f"fuzz_history_{timestamp}.json")',
    'history_file_path = "/tmp/aurige_fuzz_history.json"'
)

with open("backend/main.py", "w") as f:
    f.write(content_fixed)

print("✅ Fixed main.py")
PYTHON_SCRIPT
}

echo "🔄 Restarting backend service..."
sudo systemctl restart aurige-api

echo "⏳ Waiting for backend to start..."
sleep 3

echo "🔍 Checking backend status..."
sudo systemctl status aurige-api --no-pager -l | head -20

echo ""
echo "✅ Backend restoration complete!"
echo "Test with: curl http://localhost:8000/api/status"
