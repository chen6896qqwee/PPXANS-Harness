// test/fixtures/cwd-worker.js — Legion cwd 传递验证用最小 worker
import fs from "node:fs";
if (process.env.PPX_TEST_CWD_OUT) {
  fs.writeFileSync(process.env.PPX_TEST_CWD_OUT, process.cwd(), "utf8");
}
process.exit(0);
