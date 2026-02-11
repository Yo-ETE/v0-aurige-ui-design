#!/usr/bin/env python3
"""
Quick script to check if backend/main.py has syntax errors.
Run this with: python3 scripts/check_python_syntax.py
"""

import sys
import py_compile
from pathlib import Path

def check_syntax(filepath):
    """Check Python file for syntax errors."""
    try:
        py_compile.compile(filepath, doraise=True)
        print(f"✓ {filepath} - Syntax OK")
        return True
    except py_compile.PyCompileError as e:
        print(f"✗ {filepath} - Syntax Error:")
        print(f"  {e}")
        return False

if __name__ == "__main__":
    backend_file = Path(__file__).parent.parent / "backend" / "main.py"
    
    if not backend_file.exists():
        print(f"ERROR: {backend_file} does not exist!")
        sys.exit(1)
    
    print(f"Checking {backend_file}...")
    if check_syntax(str(backend_file)):
        print("\n✓ Backend Python syntax is valid!")
        sys.exit(0)
    else:
        print("\n✗ Backend Python has syntax errors - fix before restarting services")
        sys.exit(1)
