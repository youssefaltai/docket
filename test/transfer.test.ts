import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rowsPage } from "../src/server/transfer.ts";

test("rowsPage pages a normal table by rowid and a WITHOUT ROWID table by offset, to the end", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE a (x TEXT)");
  db.run("CREATE TABLE b (r INTEGER NOT NULL, p TEXT NOT NULL, PRIMARY KEY (r, p)) WITHOUT ROWID");
  for (let i = 0; i < 1200; i++) {
    db.run("INSERT INTO a VALUES (?)", [`v${i}`]);
    db.run("INSERT INTO b VALUES (?, ?)", [i % 7, `p${i}`]);
  }
  for (const table of ["a", "b"]) {
    let seen = 0;
    for (let after = 0; ; ) {
      const page = rowsPage(db as never, table, after);
      if (!page.rows.length) break;
      seen += page.rows.length;
      after = page.next;
    }
    expect(seen).toBe(1200);
  }
});
