#!/usr/bin/env python3
"""
Emergency fix script to repair backend/main.py syntax errors.
This script removes the broken try-except wrapper that was causing indentation issues.
"""

import sys
import re
from pathlib import Path

def fix_start_fuzzing():
    """Remove the try-except wrapper from start_fuzzing that broke indentation"""
    
    backend_file = Path(__file__).parent.parent / "backend" / "main.py"
    
    if not backend_file.exists():
        print(f"ERROR: {backend_file} not found")
        return False
    
    print(f"Reading {backend_file}...")
    with open(backend_file, 'r') as f:
        content = f.read()
    
    # Find the start_fuzzing function and remove the try-except wrapper
    # The issue is that we added "try:" at the beginning but indentation is broken
    
    # Pattern: Find the function definition
    pattern = r'(@app\.post\("/api/fuzzing/start"\)\s+async def start_fuzzing\(request: FuzzingRequest\):.*?\n)(    try:\n)'
    
    # Remove the "try:" line that was added
    fixed_content = re.sub(pattern, r'\1', content, flags=re.DOTALL, count=1)
    
    # Now find and remove the except block at the end of start_fuzzing
    # Look for the except HTTPException block
    except_pattern = r'\n    except HTTPException:\n        raise\n    except Exception as e:.*?detail=f"Failed to start fuzzing: \{str\(e\)\}"\n        \)\n'
    fixed_content = re.sub(except_pattern, '\n', fixed_content, flags=re.DOTALL)
    
    # De-indent all the code that was indented for the try block
    # Find lines that start with 8+ spaces after the function definition
    # and reduce by 4 spaces
    lines = fixed_content.split('\n')
    fixed_lines = []
    in_start_fuzzing = False
    function_ended = False
    
    for i, line in enumerate(lines):
        if '@app.post("/api/fuzzing/start")' in line:
            in_start_fuzzing = True
            fixed_lines.append(line)
        elif in_start_fuzzing and not function_ended:
            # Check if we've reached the next function or decorator
            if line.strip().startswith('@app.') or (line.strip().startswith('async def ') and 'start_fuzzing' not in line):
                function_ended = True
                in_start_fuzzing = False
                fixed_lines.append(line)
            elif line.startswith('        ') and not line.strip().startswith('"""'):
                # De-indent by 4 spaces (was indented for try block)
                fixed_lines.append(line[4:])
            else:
                fixed_lines.append(line)
        else:
            fixed_lines.append(line)
    
    fixed_content = '\n'.join(fixed_lines)
    
    # Write backup
    backup_file = backend_file.with_suffix('.py.backup')
    print(f"Creating backup at {backup_file}...")
    with open(backup_file, 'w') as f:
        f.write(content)
    
    # Write fixed content
    print(f"Writing fixed content to {backend_file}...")
    with open(backend_file, 'w') as f:
        f.write(fixed_content)
    
    print("✓ Fix applied successfully!")
    print("Please restart the backend service: sudo systemctl restart aurige-api")
    return True

if __name__ == "__main__":
    try:
        if fix_start_fuzzing():
            sys.exit(0)
        else:
            sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
