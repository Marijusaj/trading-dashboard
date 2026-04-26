// One-shot migration runner. Hit with:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//        https://<domain>/api/admin/migrate
// Idempotent — uses CREATE TABLE IF NOT EXISTS.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/neon";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Split SQL into individual statements on `;` boundaries.
 *  Strips comments and ignores semicolons inside string literals.
 *  Good enough for our migrations (no PL/pgSQL functions).
 */
function splitStatements(sql: string): string[] {
  // Strip line comments
  const noComments = sql.replace(/--[^\n]*\n/g, "\n");
  const stmts: string[] = [];
  let buf = "";
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      buf += ch;
      if (ch === stringChar && noComments[i - 1] !== "\\") {
        inString = false;
      }
    } else if (ch === "'" || ch === '"') {
      buf += ch;
      inString = true;
      stringChar = ch;
    } else if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) stmts.push(trimmed);
      buf = "";
    } else {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) stmts.push(tail);
  return stmts;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = db();
    const migrationsDir = join(process.cwd(), "db", "migrations");
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

    const applied: { file: string; statements: number }[] = [];
    for (const file of files) {
      const content = readFileSync(join(migrationsDir, file), "utf8");
      const statements = splitStatements(content);
      for (const stmt of statements) {
        // sql.query is the raw-string variant; the tagged-template form
        // doesn't accept dynamic strings safely.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (sql as any).query(stmt);
      }
      applied.push({ file, statements: statements.length });
    }

    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
