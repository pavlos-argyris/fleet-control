#!/usr/bin/env python3
"""Read-only SQLite comparison for cloud return. Never imports or activates data.
Input must be consistent exported SQLite snapshots, never a live database path.
Output contains table/column names, counts and hashes, never row values.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def typed(value):
    if value is None:
        return b'n'
    if isinstance(value, int):
        return b'i' + str(value).encode('ascii')
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Non-finite SQLite value requires manual review')
        return b'r' + struct.pack('>d', value)
    if isinstance(value, bytes):
        return b'b' + value
    return b't' + value.encode('utf-8')


def row_hash(row):
    digest = hashlib.sha256()
    for value in row:
        data = typed(value)
        digest.update(struct.pack('>Q', len(data)))
        digest.update(data)
    return digest.hexdigest()


def inspect_snapshot(filename):
    # mode=ro prevents creation/mutation. Do not use immutable=1: it could hide WAL.
    path = Path(filename).resolve(strict=True)
    if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-journal')):
        raise ValueError('Export a consistent standalone SQLite snapshot first')
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('BEGIN')
        if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite integrity check failed')
        if connection.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('SQLite foreign key check failed')
        tables = {}
        for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            columns = list(connection.execute('PRAGMA table_xinfo(' + quote(name) + ')'))
            if any(c[6] for c in columns):
                raise ValueError('Generated/hidden columns require a reviewed transfer adapter')
            # A multiset retains duplicate multiplicity and ignores physical row order.
            rows = collections.Counter(row_hash(row) for row in connection.execute('SELECT * FROM ' + quote(name)))
            schema = [list(c[1:]) for c in columns]
            digest = hashlib.sha256(json.dumps(sorted(rows.items()), separators=(',', ':')).encode()).hexdigest()
            tables[name] = {'columns': schema, 'rows': sum(rows.values()), 'contentSha256': digest, '_rows': rows}
            if name == 'fleet_snapshot':
                snapshot = connection.execute('SELECT data FROM fleet_snapshot WHERE id=1').fetchone()
                if snapshot:
                    fleet = json.loads(snapshot[0])
                    if not isinstance(fleet, dict) or not isinstance(fleet.get('bikes'), list):
                        raise ValueError('Invalid fleet snapshot')
                    tables[name]['fleetBikeCount'] = len(fleet['bikes'])
        return tables
    finally:
        connection.close()


def compare(source_path, cloud_path):
    source, cloud = inspect_snapshot(source_path), inspect_snapshot(cloud_path)
    result = []
    for name in sorted(source.keys() | cloud.keys()):
        a, b = source.get(name), cloud.get(name)
        if a is None:
            state = 'cloud_only_requires_classification'
        elif b is None:
            state = 'source_only_requires_cloud_adapter'
        elif a['columns'] != b['columns']:
            state = 'schema_difference_requires_review'
        elif a['_rows'] != b['_rows']:
            state = 'content_difference_requires_reconciliation'
        else:
            state = 'identical'
        item = {'table': name, 'state': state}
        for label, value in [('source', a), ('cloud', b)]:
            item[label] = None if value is None else {k: v for k, v in value.items() if k != '_rows'}
        if a and b and a['columns'] == b['columns']:
            item['sourceOnlyRows'] = sum((a['_rows'] - b['_rows']).values())
            item['cloudOnlyRows'] = sum((b['_rows'] - a['_rows']).values())
        result.append(item)
    source_bikes = source.get('fleet_snapshot', {}).get('fleetBikeCount')
    cloud_bikes = cloud.get('fleet_snapshot', {}).get('fleetBikeCount')
    return {'schema': 1, 'readOnly': True, 'activationAllowed': False,
            'cloudDataMustBePreserved': True,
            'emptySourceFleetWithCloudData': source_bikes == 0 and isinstance(cloud_bikes, int) and cloud_bikes > 0,
            'restoreVerified': False, 'objectsVerified': False,
            'note': 'Comparison only. Table classification, object transfer, writer fencing, backup and exact-source release checks are still required.',
            'tables': result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--cloud', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args.source, args.cloud), ensure_ascii=False, indent=2))
    except (ValueError, sqlite3.DatabaseError, OSError, TypeError):
        # Database errors can contain data/SQL. Do not echo them to diagnostics.
        parser.exit(2, 'Snapshot comparison failed; check consistent exports and integrity locally.\n')


if __name__ == '__main__':
    main()
