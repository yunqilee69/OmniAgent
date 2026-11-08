/** Subset of DSH's browser-safe file-drag contract used by the primitives. */
export interface DragFileName {
  readonly name?: string | undefined
  readonly mediaType: string
  readonly outputExtension?: string | undefined
}
