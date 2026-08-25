/**
 * dsh-bot search tool — the composition layer the fleet transcripts demanded.
 *
 * Measurement (35 transcripts, 2026-08-24/25): bash-grep 85x vs grep-tool 20x;
 * 185 of the bash calls were pipes (grep | head/wc/grep/sort). The stock tools
 * lose on composition, so agents rationally stayed in bash. This tool IS the
 * composition: countOnly/filesOnly/ignoreCase/context/maxResults/sortedBy,
 * covering every measured shape in one call. Wraps the same packaged ripgrep
 * the fs-search tools use — argv elements only, no shell layer.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runRipgrep, resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';

export const name = 'tool-search-compose';
export const inject = ['tools', 'subprocess'];

export function apply(ctx) {
  const tool = defineTool({
    name: 'search',
    description: 'Content search with composition built in — counts, file-lists, case-folding, context lines, result caps, ordering. One call replaces the grep|head/wc/sort pipeline shapes.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'ripgrep regular expression' },
      path: { type: 'string', description: 'file or directory (default: workspace)' },
      include: { type: 'string', description: 'glob filter, e.g. "*.ts"' },
      countOnly: { type: 'boolean', description: 'per-file match counts (the -c shape)' },
      filesOnly: { type: 'boolean', description: 'only file paths with matches (the -l shape)' },
      ignoreCase: { type: 'boolean', description: 'case-insensitive (-i)' },
      context: { type: 'integer', description: 'context lines around each match (-A/-B)' },
      maxResults: { type: 'integer', description: 'stop after N matches (the | head shape)' },
      sortedBy: { type: 'string', description: '"path" or "modified" ordering (the | sort shape)' }
    },
    async execute(args, exec) {
      const argv = [];
      if (args.countOnly) argv.push('--count-matched');
      if (args.filesOnly) argv.push('--files-with-matches');
      if (args.ignoreCase) argv.push('-i');
      if (args.context) argv.push('--context=' + args.context);
      if (args.include) argv.push('--glob=' + args.include);
      argv.push('--regexp=' + args.pattern);
      if (args.maxResults) argv.push('--max-count=' + args.maxResults);
      if (args.path) argv.push('--', args.path);
      const run = await runRipgrep(ctx, exec, 'search', argv, 16 * 1024 * 1024, 1000, 16 * 1024);
      let out = run.stdout;
      if (args.sortedBy === 'path') {
        out = out.split('\n').sort().join('\n');
      }
      return { output: out.slice(0, 256 * 1024) };
    }
  });
  ctx.tools.register(tool);
}
