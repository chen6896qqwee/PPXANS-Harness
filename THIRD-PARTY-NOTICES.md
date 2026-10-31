# Third-Party Notices

PPXANS-Harness itself is licensed under **Apache-2.0** (see [LICENSE](LICENSE)).
This file lists third-party components that are distributed with, or used to
build, the Windows client.

## Distributed with the desktop installer

| Component | Version | License | Where |
|---|---|---|---|
| Electron | 45.x | MIT | Bundled runtime; license at `LICENSE.electron.txt` in the install directory |
| Chromium + bundled components | (Electron 45) | BSD-style and others | Bundled runtime; full texts in `LICENSES.chromium.html` |

The NSIS installer places both license files next to `PPXANS-Harness.exe`.
They must not be removed when redistributing the installer or an installed copy.

## Distributed with the standalone package (optional)

| Component | Version | License | Where |
|---|---|---|---|
| Node.js | 22.14.0 | MIT | `runtime/node.exe`; license at `runtime/LICENSE.node.txt` |

The standalone bundle (`scripts/package.js`) embeds the official Node.js
Windows x64 runtime, verified against `SHASUMS256.txt`. Redistributions must
keep `runtime/LICENSE.node.txt`.

## Build-time only (not distributed)

| Component | Version | License |
|---|---|---|
| electron-builder | 26.x | MIT |
| ESLint | 9.x | MIT |
| globals | 17.x | MIT |

These tools are used to produce the installers and are not part of the
shipped application.

## Bundled third-party skills

`skills/` contains skills imported from upstream skill libraries. Each imported
skill directory keeps its original `LICENSE.txt` where upstream provided one.
`skills/office/{docx,pdf,pptx,xlsx}` are not imported: they are maintained in
this repository as original implementations under Apache-2.0, and ship no
upstream files.

| Upstream | Skills | License |
|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills) | academy-guide, algorithmic-art, brand-guidelines, canvas-design, claude-api, discernment-nudge, frontend-design, internal-comms, mcp-builder, skill-creator, theme-factory, web-artifacts-builder, webapp-testing | Apache-2.0 (`LICENSE.txt` in each directory) |
| anthropics/skills | doc-coauthoring | Upstream license file was not copied with the skill; check the upstream repository before redistribution |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | api-and-interface-design, code-simplification, context-engineering, doubt-driven-development, observability-and-instrumentation, performance-optimization, security-and-hardening, spec-driven-development | MIT |
| [obra/superpowers](https://github.com/obra/superpowers) | receiving-code-review, using-git-worktrees | MIT |

Fonts under `skills/content/canvas-design/canvas-fonts/` are distributed with
their SIL Open Font License texts (`*-OFL.txt`).

MIT license text for the addyosmani/agent-skills and obra/superpowers skills:

```text
MIT License

Copyright (c) 2025 Addy Osmani
Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Architecture references

Design ideas were informed by the projects listed in the README section
“架构来源与致谢”; their source code is not bundled. The imported skills above
are the only third-party source files shipped in this repository. See
`references/THIRD-PARTY-SOURCES.md` for the registry.
