/**
 * dsh-bot search tool — the composition layer the fleet transcripts demanded.
 *
 * Measurement (35 transcripts, 2026-08-24/25): bash-grep 85x vs grep-tool 20x;
 * 185 of the bash calls were pipes (grep | head/wc/grep/sort). The stock tools
 * lose on composition, so agents rationally stayed in bash. This tool IS the
 * composition: countOnly/filesOnly/ignoreCase/context/maxResults/sortedBy,
 * covering every measured shape in one call. Wraps the same packaged ripgrep
 * the fs-search tools use — argv elements only, no shell layer.
 *
 * Packaging (issue #40; the f2972e7 revert): this file ships as a REAL package
 * (package.json + lib/) that the launcher copies into the profile module tree
 * ($DSH_HOME/profiles/node_modules/@dsh-bot/tool-search-compose), where its
 * bare `@deepseek-ai/*` imports resolve through the profile's flat fallback —
 * the mount that crashed every launch at f2972e7 pointed at this file's bare
 * IN-TREE path, which resolves nothing (no node_modules beside it). The
 * overlay is stamped per-run by scripts/run-dsh-agent.sh under
 * DSH_SEARCH_COMPOSE=1; see README.md in this directory.
 *
 * All search budgets (stdout cap, grace, stderr cap, tool timeout) come from
 * the fs-search package's own constants: the composition tool runs on exactly
 * the budgets the shipped grep/glob tools run on, not private ones.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  runRipgrep,
} from "@deepseek-ai/dsh-tool-fs-search";
import { capResults, buildRipgrepArgs } from "./compose.js";

// Byte cap on the model-facing output (post line-cap; belt and braces from
// the original shape — a bounded answer even for a pathologically long line).
const OUTPUT_MAX_BYTES = 256 * 1024;

export const name = "tool-search-compose";
export const inject = ["tools", "subprocess"];

export function apply(ctx) {
  const tool = defineTool({
    name: "search",
    description: "Content search with composition built in — counts, file-lists, case-folding, context lines, result caps, ordering. One call replaces the grep|head/wc/sort pipeline shapes.",
    parameters: {
      pattern: { type: "string", required: true, description: "ripgrep regular expression" },
      path: { type: "string", description: "file or directory (default: workspace)" },
      include: { type: "string", description: 'glob filter, e.g. "*.ts"' },
      countOnly: { type: "boolean", description: "per-file match counts (the -c shape)" },
      filesOnly: { type: "boolean", description: "only file paths with matches (the -l shape)" },
      ignoreCase: { type: "boolean", description: "case-insensitive (-i)" },
      context: { type: "integer", description: "context lines on both sides of each match (--context)" },
      maxResults: { type: "integer", description: "keep the first N result lines IN TOTAL across all files (the | head shape — not per-file)" },
      sortedBy: { type: "string", description: '"path" or "modified" file ordering (the | sort shape)' }
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          output: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.output }]
    },
    async execute(args, exec) {
      const argv = buildRipgrepArgs(args);
      const run = await runRipgrep(ctx, exec, "search", argv, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES);
      const out = capResults(run.noMatches ? "" : run.stdout, args.maxResults);
      return { output: out.slice(0, OUTPUT_MAX_BYTES) };
    }
  });
  ctx.tools.register(tool);
}
