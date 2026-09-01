interface SqliteExecutor {
  exec(sql: string): unknown;
}

export function withImmediateTransaction<T>(
  database: SqliteExecutor,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    return operation();
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
