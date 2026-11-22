#!/usr/bin/env python3
"""
HA SolarPayBack — HA-side persistence script.

Called via shell_command from Home Assistant.
Accepts JSON on stdin containing gridEvents + tariffHistory,
writes atomically to /config/ha-solarpayback-data.json (temp file + rename).

Usage:
  python3 /config/packages/ha_solarpayback_store.py < /path/to/input.json
  # or via HA shell_command: ha_solarpayback_store '<json_string>'
"""

import json
import os
import sys
import tempfile
from pathlib import Path

# Output file location (inside /config so it's backed up by HA)
DATA_FILE = Path('/config/ha-solarpayback-data.json')


def main():
    # Read JSON from argv[1] (HA shell_command passes data as templated argument)
    # Usage in configuration.yaml:
    #   shell_command:
    #     ha_solarpayback_store: 'python3 /config/packages/ha_solarpayback_store.py "{{ data | tojson }}"'
    if len(sys.argv) < 2:
        print('Error: no data argument provided', file=sys.stderr)
        sys.exit(1)

    raw = sys.argv[1]

    if not raw or not raw.strip():
        print('Error: empty input', file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f'Error: invalid JSON: {e}', file=sys.stderr)
        sys.exit(1)

    # Validate structure: expect { gridEvents: [...], tariffHistory: [...] }
    # Be permissive: accept partial data, merge with existing if file exists
    grid_events = data.get('gridEvents', [])
    tariff_history = data.get('tariffHistory', [])

    # Load existing to merge (in case only one store is sent)
    existing = {'gridEvents': [], 'tariffHistory': []}
    if DATA_FILE.exists():
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                existing = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass  # Start fresh if corrupt

    # Merge: new data replaces (full sync from app)
    merged = {
        'gridEvents': grid_events,
        'tariffHistory': tariff_history,
        'savedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z'
    }

    # Atomic write: temp file + rename
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode='w',
        encoding='utf-8',
        dir=DATA_FILE.parent,
        prefix='.ha-solarpayback-data.',
        suffix='.tmp',
        delete=False
    ) as tmp:
        json.dump(merged, tmp, separators=(',', ':'))
        tmp_path = tmp.name

    try:
        os.replace(tmp_path, DATA_FILE)
    except OSError:
        # Cleanup temp on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    print(json.dumps({'ok': True, 'path': str(DATA_FILE)}))


if __name__ == '__main__':
    main()