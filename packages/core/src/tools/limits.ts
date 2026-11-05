/** 回灌给模型的单次工具输出上限。超出就截断，别把上下文一次撑爆。 */
export const MAX_OUTPUT_CHARS = 30_000;

/** 单个文件的默认读取行数。 */
export const DEFAULT_READ_LINES = 2_000;

/** 单次 read_file 读取的文件字节上限；超过时要求分段或改用 shell。 */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** 单次 list_dir 收集的目录条目上限。 */
export const MAX_DIRECTORY_ENTRIES = 10_000;
