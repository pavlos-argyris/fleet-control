"""Synthetic SQLite regression bridge; never connects to a remote database."""
import json,sqlite3,sys
database,raw=sys.argv[1:3]
command=json.loads(raw)
with sqlite3.connect(database) as db:
    db.row_factory=sqlite3.Row
    db.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,1)
    if command.get("mode")=="script":
        db.executescript(command["sql"])
        rows=[]
    else:
        rows=[dict(row) for row in db.execute(command["sql"],command.get("params",[])).fetchall()]
    print(json.dumps(rows,ensure_ascii=False))
