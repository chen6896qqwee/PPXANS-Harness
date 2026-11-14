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

## Bundled in the Web UI (build-time dependencies)

The browser UI (`webapp/`, Vue 3 + Vite) renders Markdown, code and math with
four libraries. Since v5.0 they are ordinary root `devDependencies` in
`package.json`: `npm run web:build` runs Vite, which bundles them (plus Vue) into
`webapp/dist/assets/`. The built assets are committed, so a clone runs without
an extra install; `npm run web:check` re-verifies that `dist/index.html` and the
assets it references are present.

They are **not** runtime dependencies of the Node kernel: `dependencies` stays
empty, the kernel loads nothing at run time, and the UI never fetches from a CDN.

| Component | Version | License | What it does |
|---|---|---|---|
| [Vue](https://github.com/vuejs/core) | 3.5.x | MIT | UI framework for the webapp SPA |
| [Vite](https://github.com/vitejs/vite) | 7.x | MIT | Build/dev server; emits `webapp/dist` |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 14.x | MIT | Markdown → HTML (`html:false`, so raw HTML in model output stays text) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.x | Apache-2.0 OR MPL-2.0 | Sanitizes the rendered HTML before it reaches the DOM |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.x | MIT | `$inline$` / `$$block$$` math (fonts emitted into `webapp/dist/assets/`) |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.x | BSD-3-Clause | Syntax highlighting for fenced code blocks |

Exact versions live in `package.json`; each package keeps its upstream `LICENSE`
inside `node_modules/<name>/`. highlight.js is themed by our own token colors in
the webapp stylesheet rather than by an upstream stylesheet, so the same markup
follows both the dark and the light palettes.

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
are the only third-party source files shipped in this repository; the Web UI
libraries are npm packages bundled into `webapp/dist` at build time. See
`references/THIRD-PARTY-SOURCES.md` for the registry.
