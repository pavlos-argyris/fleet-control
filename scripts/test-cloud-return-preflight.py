#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('cloud-return-preflight.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PreflightTest(unittest.TestCase):
    def test_typed_history_and_no_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            a, b = (Path(folder) / name for name in ('source.db', 'cloud.db'))
            for path in (a, b):
                with sqlite3.connect(path) as db:
                    db.execute('CREATE TABLE history(value)')
                    db.executemany('INSERT INTO history VALUES(?)', [(9223372036854775807,), (1,), (1.0,), (b'',), (None,), ('private-canary',), ('διπλό',), ('διπλό',)])
            before = a.read_bytes(), b.read_bytes()
            report = module.compare(a, b)
            self.assertEqual(report['tables'][0]['state'], 'identical')
            self.assertFalse(report['activationAllowed'])
            self.assertNotIn('private-canary', json.dumps(report))
            self.assertEqual(before, (a.read_bytes(), b.read_bytes()))
            with sqlite3.connect(b) as db:
                db.execute('DELETE FROM history WHERE rowid=8')
                db.execute('UPDATE history SET value=1 WHERE rowid=3')
                db.execute('CREATE TABLE cloud_extra(id INTEGER)')
            report = module.compare(a, b)
            history = next(t for t in report['tables'] if t['table'] == 'history')
            self.assertEqual(history['sourceOnlyRows'], 2)
            self.assertEqual(history['cloudOnlyRows'], 1)
            self.assertEqual(history['state'], 'content_difference_requires_reconciliation')
            self.assertEqual(report['tables'][0]['state'], 'cloud_only_requires_classification')

    def test_invalid_or_live_input_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.db'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE records(id INTEGER)')
            Path(str(path) + '-wal').touch()
            with self.assertRaises(ValueError):
                module.inspect_snapshot(path)
            self.assertRaises(FileNotFoundError, module.inspect_snapshot, Path(folder) / 'missing.db')
            self.assertFalse((Path(folder) / 'missing.db').exists())

if __name__ == '__main__':
    unittest.main()
