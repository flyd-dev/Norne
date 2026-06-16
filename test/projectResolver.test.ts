import { describe, expect, it } from "vitest";
import {
  PROJECT_NAME_FIELDS,
  resolveProject,
  projectLabel,
} from "@/lib/chat/projectResolver";

const projects = [
  { id: "GSLeXiSkaiAkEqcuFxIx", name: "Solsiden" },
  { id: "AbCdEfGhIjKlMnOpQrSt", name: "Nordlys" },
];

describe("resolveProject", () => {
  it("resolves by explicit id", () => {
    const r = resolveProject("vis budsjett", "GSLeXiSkaiAkEqcuFxIx", projects);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.projectId).toBe("GSLeXiSkaiAkEqcuFxIx");
      expect(r.matchedBy).toBe("id");
    }
  });

  it("resolves by id mentioned in the text", () => {
    const r = resolveProject(
      "hva er budsjettet for AbCdEfGhIjKlMnOpQrSt?",
      null,
      projects,
    );
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.projectId).toBe("AbCdEfGhIjKlMnOpQrSt");
  });

  it("resolves by human-readable name", () => {
    const r = resolveProject("budsjettlinjer for Solsiden", null, projects);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.projectId).toBe("GSLeXiSkaiAkEqcuFxIx");
      expect(r.matchedBy).toBe("name");
    }
  });

  it("returns not_found when no project matches", () => {
    const r = resolveProject("budsjett for Ukjentprosjekt", null, projects);
    expect(r.status).toBe("not_found");
    if (r.status === "not_found") {
      expect(r.message).toContain("Solsiden");
      expect(r.message).toContain("Nordlys");
    }
  });

  it("returns ambiguous when multiple projects share the same name", () => {
    const dupes = [
      { id: "p1", name: "Bygg A" },
      { id: "p2", name: "Bygg A" },
    ];
    const r = resolveProject("vis Bygg A", null, dupes);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidates).toHaveLength(2);
      expect(r.message).toContain("p1");
      expect(r.message).toContain("p2");
    }
  });

  it("prefers the longest matching name (substring disambiguation)", () => {
    const overlapping = [
      { id: "p1", name: "Bygg" },
      { id: "p2", name: "Bygg A" },
    ];
    const r = resolveProject("budsjett for Bygg A", null, overlapping);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.projectId).toBe("p2");
  });

  it("supports configurable name fields", () => {
    expect(PROJECT_NAME_FIELDS).toContain("projectName");
    const custom = [{ id: "x1", projectName: "Fjordgata" }];
    const r = resolveProject("mengder for Fjordgata", null, custom);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.projectId).toBe("x1");
  });

  it("resolves against the live schema fields (project_name / project_number)", () => {
    expect(PROJECT_NAME_FIELDS).toContain("project_name");
    expect(PROJECT_NAME_FIELDS).toContain("project_number");
    const real = [
      { id: "GSLeXiSkaiAkEqcuFxIx", project_name: "Fjordgata 12", project_number: "1042" },
      { id: "DU1a7I1Vj7Rp6M7hFinC", project_name: "Sentrumsbygg", project_number: "1043" },
    ];
    const byName = resolveProject("budsjett for Sentrumsbygg", null, real);
    expect(byName.status).toBe("resolved");
    if (byName.status === "resolved") expect(byName.projectId).toBe("DU1a7I1Vj7Rp6M7hFinC");

    const byNumber = resolveProject("vis mengder for prosjekt 1042", null, real);
    expect(byNumber.status).toBe("resolved");
    if (byNumber.status === "resolved") expect(byNumber.projectId).toBe("GSLeXiSkaiAkEqcuFxIx");
  });

  it("projectLabel falls back to id when no name field exists", () => {
    expect(projectLabel({ id: "only-id" })).toBe("only-id");
    expect(projectLabel({ id: "x", navn: "Med Navn" })).toBe("Med Navn");
  });
});
