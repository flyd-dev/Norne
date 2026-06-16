/**
 * Firestore service functions.
 *
 * The only place the rest of the app reads domain data from. Each function
 * returns plain typed objects and is backend-agnostic (Admin SDK or REST).
 *
 * Data model:
 *   accounts
 *   projects
 *   projects/{projectId}/budget_lines
 *   projects/{projectId}/quantities
 */

import "server-only";
import { getFirestoreClient } from "@/lib/firestore/client";
import type {
  Account,
  BudgetLine,
  Project,
  Quantity,
} from "@/lib/firestore/types";

/** Firestore collection paths — single source of truth for source tracking. */
export const COLLECTIONS = {
  accounts: "accounts",
  projects: "projects",
  budgetLines: (projectId: string) => `projects/${projectId}/budget_lines`,
  quantities: (projectId: string) => `projects/${projectId}/quantities`,
} as const;

export async function getAccounts(): Promise<Account[]> {
  return getFirestoreClient().listCollection(COLLECTIONS.accounts);
}

export async function getProjects(): Promise<Project[]> {
  return getFirestoreClient().listCollection(COLLECTIONS.projects);
}

export async function getProjectById(projectId: string): Promise<Project | null> {
  return getFirestoreClient().getDocument(COLLECTIONS.projects, projectId);
}

export async function getBudgetLines(projectId: string): Promise<BudgetLine[]> {
  return getFirestoreClient().listSubcollection(
    COLLECTIONS.projects,
    projectId,
    "budget_lines",
  );
}

export async function getQuantities(projectId: string): Promise<Quantity[]> {
  return getFirestoreClient().listSubcollection(
    COLLECTIONS.projects,
    projectId,
    "quantities",
  );
}
