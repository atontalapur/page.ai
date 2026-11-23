import { autoApprove } from '@page/toolkit';

/**
 * The eval's answer to every gated ops call (APPROVAL_TOOLS in @page/toolkit): approved, as
 * `eval`, at once. An eval run plays on its own live app, or on in-memory ops, with no one
 * watching, and the prereg measures the agent without a person in the loop, so it must never
 * wait on one. The daemon asks a person instead, unless its AUTO_APPROVE_OPS says otherwise.
 */
export const evalApprove = autoApprove('eval');
