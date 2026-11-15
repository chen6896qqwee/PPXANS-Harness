// webapp/src/layout/drawer/TreeNodes.js - 抽屉里的递归文件树 (render 函数组件, 兼容 runtime-only 构建)
// 2026-11-13 从 Drawer.vue 抽出: 递归组件与页面逻辑分开放, 组件只负责渲染与展开状态。

import { defineComponent, h } from "vue";
import { extKind } from "../../stores/panels.js";

const folderIcon = () => h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }, [h("use", { href: "#i-folder" })]);

export const TreeNodes = defineComponent({
  name: "TreeNodes",
  props: { nodes: { type: Array, required: true }, depth: { type: Number, default: 0 } },
  emits: ["open"],
  data() {
    return { openMap: {} };
  },
  methods: { extKind },
  render() {
    const kids = (n) => n.children || n.items || [];
    const renderNodes = (nodes, depth) => nodes.map((n) => {
      if (n.type === "dir" || n.dir) {
        const open = n._open || this.openMap[n.path || n.name] || depth === 0;
        return h("div", { key: "d" + (n.path || n.name) }, [
          h("button", {
            class: "dir" + (open ? " open" : ""),
            onClick: () => { this.openMap[n.path || n.name] = !open; this.$forceUpdate(); },
          }, [
            h("svg", { class: "chev", width: 10, height: 10, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" }, [h("path", { d: "m9 6 6 6-6 6" })]),
            folderIcon(),
            h("span", { class: "nm" }, n.name || n.path),
          ]),
          open && kids(n).length ? h("div", { class: "kids" }, renderNodes(kids(n), depth + 1)) : null,
        ]);
      }
      return h("button", {
        key: "f" + (n.path || n.name),
        class: "f k-" + this.extKind(n.name || n.path),
        onClick: () => this.$emit("open", n.path || n.name),
      }, [
        h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }, [h("use", { href: "#i-file" })]),
        h("span", { class: "nm" }, n.name || n.path),
      ]);
    });
    return h("div", renderNodes(this.nodes, this.depth));
  },
});
