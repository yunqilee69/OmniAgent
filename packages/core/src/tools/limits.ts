/** 回灌给模型的单次工具输出上限。超出就截断，别把上下文一次撑爆。 */
export const MAX_OUTPUT_CHARS = 30_000;

/** 单次 list_dir 收集的目录条目上限。 */
export const MAX_DIRECTORY_ENTRIES = 10_000;
