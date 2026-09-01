import { describe, expect, it } from "vitest";

import { withImmediateTransaction } from "../src/sqlite-transaction.js";

describe("withImmediateTransaction", () => {
  it("preserves the operation error when rollback also fails", () => {
    const originalError = new Error("operation failed");
    const statements: string[] = [];
    const database = {
      exec(sql: string): void {
        statements.push(sql);
        if (sql === "ROLLBACK") throw new Error("rollback failed");
      },
    };

    expect(() => withImmediateTransaction(database, () => {
      throw originalError;
    })).toThrow(originalError);
    expect(statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });
});
