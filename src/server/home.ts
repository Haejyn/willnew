import { homedir } from "node:os";
import { join } from "node:path";

/** Where willnew keeps runs, worktrees, chat and requests. `WILLNEW_HOME` overrides it (tests use a temp dir). */
export const HOME = process.env.WILLNEW_HOME ?? join(homedir(), ".willnew");
