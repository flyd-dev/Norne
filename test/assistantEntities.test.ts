/**
 * Unified entity adapters (T2.6): Endre PascalCase and Firestore snake_case both
 * normalize to the same Project / Account shape.
 */

import { describe, expect, it } from "vitest";
import { toProject, toAccount } from "@/lib/assistant/ingestion/entities";

describe("toProject", () => {
  it("reads Endre PascalCase fields", () => {
    const p = toProject({ ProjectNumber: 7100, ProjectName: "Pilestredet" }, "endre");
    expect(p).toMatchObject({ projectNumber: "7100", projectName: "Pilestredet", source: "endre" });
  });

  it("reads Firestore snake_case fields", () => {
    const p = toProject({ project_number: "3025", project_name: "AFBO NORA" }, "firebase");
    expect(p).toMatchObject({ projectNumber: "3025", projectName: "AFBO NORA", source: "firebase" });
  });

  it("keeps amount aggregates available in fields", () => {
    const p = toProject({ project_number: "1", amounts: { totals: { accepted: 5 } } }, "endre");
    expect(p.fields.amounts).toEqual({ totals: { accepted: 5 } });
  });

  it("is null-safe when fields are missing", () => {
    const p = toProject({}, "firebase");
    expect(p.projectNumber).toBeNull();
    expect(p.projectName).toBeNull();
  });
});

describe("toAccount", () => {
  it("reads account number + name across naming styles", () => {
    expect(toAccount({ account_number: "6570", name: "Verneutstyr" })).toMatchObject({
      accountNumber: "6570",
      name: "Verneutstyr",
    });
    expect(toAccount({ Kontonummer: 4000, Kontonavn: "Varekjøp" })).toMatchObject({
      accountNumber: "4000",
      name: "Varekjøp",
    });
  });
});
