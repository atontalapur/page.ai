import { approverNameSchema } from '@page/contracts';

// The name a person approves or rejects Tier 3 requests under, kept in this browser so every
// tab sends the same one. localStorage can be missing or throw (a private window, blocked
// site data), so every access is guarded and the UI then asks again.
const KEY = 'page-ai-approver-name';

/** The saved name, or null when there is none or it no longer passes the contract. */
export function readApproverName(): string | null {
  try {
    const parsed = approverNameSchema.safeParse(localStorage.getItem(KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveApproverName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Kept in memory by the caller for this page load.
  }
}
