/**
 * compose.js — the pure core of the composition search tool: argument
 * validation, ripgrep argv construction, and the total result cap.
 *
 * Deliberately dependency-free (no `@deepseek-ai` imports): this repo's
 * gates run `node --test` with no dsh packages on the module path, so the
 * testable logic must not sit behind them — lib/index.js keeps only the
 * plugin wiring.
 *
 * Flag ground truth verified against the packaged ripgrep the fs-search
 * seam runs (@vscode/ripgrep 15.0.0; re-verified by the PR #43 reviews on
 * a dsh lane):
 *   - there is NO `--max-results` flag: a total cap has to be applied
 *     AFTER the run. `--max-count` caps matches PER FILE, so across N files
 *     it returns up to files × N — never the documented `| head` number;
 *   - `--count-matched` does not exist (`--count` and `--count-matches`
 *     do; `-c` is the per-file shape the parameter documents);
 *   - `--sort=path|modified` orders FILES (path or mtime) and keeps each
 *     file's matches in line order — it composes with `--count` and
 *     `--files-with-matches`. Sorting raw output LINES string-wise instead
 *     scrambles within-file order (`file:10:…` sorts before `file:9:…`),
 *     so ordering is delegated to ripgrep, never done here;
 *   - `--context` with `--count` or `--files-with-matches` exits 0 with
 *     the context flag silently ignored — a lying shape, so the
 *     combination is rejected here before rg ever runs (review r1
 *     finding 2 on the PR #43 lineage).
 */

export const SORT_MODES = ["path", "modified"];

const positiveInteger = (value) => Number.isInteger(value) && value > 0;

function fail(message) {
  throw new TypeError(`search: ${message}`);
}

/**
 * Validate the tool arguments and build the ripgrep argv (elements only —
 * the fs-search seam spawns it directly, no shell layer). Throws TypeError
 * with the offending value named for every malformed argument: a silently
 * ignored parameter is a lying schema (issue #40), and rg's own exit on a
 * bad flag is a worse error than a typed one here.
 */
export function buildRipgrepArgs(args = {}) {
  if (typeof args.pattern !== "string" || args.pattern === "") {
    fail(`pattern is required (non-empty string), got ${JSON.stringify(args.pattern ?? null)}`);
  }
  if (args.countOnly && args.filesOnly) {
    fail("countOnly and filesOnly are mutually exclusive — one asks for counts, the other for paths");
  }
  if (args.context != null && (args.countOnly || args.filesOnly)) {
    fail("context is incompatible with countOnly/filesOnly — counts and file lists carry no context lines");
  }
  const argv = [];
  if (args.countOnly) argv.push("--count");
  if (args.filesOnly) argv.push("--files-with-matches");
  if (args.ignoreCase) argv.push("-i");
  if (args.context != null) {
    if (!positiveInteger(args.context)) {
      fail(`context must be a positive integer, got ${JSON.stringify(args.context)}`);
    }
    argv.push(`--context=${args.context}`);
  }
  if (args.include != null) {
    if (typeof args.include !== "string" || args.include === "") {
      fail(`include must be a non-empty glob string, got ${JSON.stringify(args.include)}`);
    }
    argv.push(`--glob=${args.include}`);
  }
  if (args.maxResults != null && !positiveInteger(args.maxResults)) {
    fail(`maxResults must be a positive integer, got ${JSON.stringify(args.maxResults)}`);
  }
  if (args.sortedBy != null) {
    if (!SORT_MODES.includes(args.sortedBy)) {
      fail(`sortedBy must be one of ${SORT_MODES.map((m) => JSON.stringify(m)).join(" / ")}, got ${JSON.stringify(args.sortedBy)}`);
    }
    argv.push(`--sort=${args.sortedBy}`);
  }
  argv.push(`--regexp=${args.pattern}`);
  if (args.path != null) {
    if (typeof args.path !== "string" || args.path === "") {
      fail(`path must be a non-empty string, got ${JSON.stringify(args.path)}`);
    }
    argv.push("--", args.path);
  }
  return argv;
}

/**
 * The `| head` shape: cap the result LINES in total across the whole run
 * (all files). ripgrep has no total-cap flag, so this is the only honest
 * implementation of maxResults. Anything at or under the cap passes through
 * byte-identical; a cut keeps the trailing newline rg always emits.
 */
export function capResults(out, maxResults) {
  if (maxResults == null) return out;
  if (!positiveInteger(maxResults)) {
    fail(`maxResults must be a positive integer, got ${JSON.stringify(maxResults)}`);
  }
  const lines = out.split("\n");
  // rg output ends in "\n", so the final split element is "" — a delimiter
  // artifact, not a result line.
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === "" ? 1 : 0;
  if (lines.length - trailingEmpty <= maxResults) return out;
  return lines.slice(0, maxResults).join("\n") + "\n";
}
