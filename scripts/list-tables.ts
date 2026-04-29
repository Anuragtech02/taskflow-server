/** Lists tables in the connected DATABASE_URL. Read-only. */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;
  console.log(`Database: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`Tables in public schema: ${tables.length}`);
  for (const t of tables) console.log(`  ${t.tablename}`);
} finally {
  await sql.end();
}
