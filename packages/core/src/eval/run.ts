import { formatEvalResults, runEvalSuite } from './harness';
import { basicSuite } from './suites/basic';

/**
 * eval 命令行入口。
 *
 *   pnpm eval
 *   pnpm eval -- --keep   # 失败时保留临时工作区
 *
 * 退出码：有失败用例时非 0，方便以后接 CI。
 */
async function main(): Promise<void> {
  const keepWorkspace = process.argv.includes('--keep');
  const suite = await runEvalSuite(basicSuite, { keepWorkspace });
  console.log(formatEvalResults(suite));

  if (suite.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('eval 运行失败：', error);
  process.exitCode = 1;
});
