/** The contract every preview viewer implements. */
export interface ViewerProps {
  /** Registered workspace id, for building raw URLs. */
  workspaceId: string;
  /** Workspace-relative path of the previewed file. */
  path: string;
  /** UTF-8 body for text-like kinds; undefined for binary kinds. */
  text?: string | undefined;
  /** Raw byte body for kinds a parser reads in memory. */
  bytes?: Uint8Array | undefined;
  /** Same-origin raw URL for kinds the browser renders itself. */
  url?: string | undefined;
  /** First line to reveal, from a `path:line` reference. */
  line?: number | undefined;
}

/** One file selected for preview in the right panel. */
export interface FileSelection {
  workspaceId: string;
  workspaceName: string;
  path: string;
  /** First line to reveal, from a `path:line` link in the transcript. */
  line?: number;
}
