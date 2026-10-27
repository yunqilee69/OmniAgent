import { isAbsolute, relative, resolve } from 'node:path';

/**
 * 工作区内的路径解析（第一道防线，不是沙盒）。
 *
 * 现在只做纯字符串层面的越权检查，**不解析符号链接**——
 * 所以它能挡住 `../../etc/passwd`，挡不住指向外部的 symlink。
 * 这是 M3 做沙盒时要补的洞，先把认知写在这里，别假装它安全。
 */
export function resolveInside(cwd: string, input: string): string {
  const absolute = resolve(cwd, input);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越出工作区：${input}`);
  }
  return absolute;
}

/** 用来读显示的相对路径。 */
export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel === '' ? '.' : rel;
}
