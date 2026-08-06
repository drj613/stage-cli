export const SCOPE_KIND = {
	COMMITTED: "committed",
	WORKING_TREE: "workingTree",
} as const;
export type ScopeKind = (typeof SCOPE_KIND)[keyof typeof SCOPE_KIND];
