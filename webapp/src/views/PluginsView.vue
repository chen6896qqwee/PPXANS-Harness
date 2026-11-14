<!-- webapp/src/views/PluginsView.vue - 插件管理页 (保存只落盘, 重启应用生效) -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { admin, accessLabel, PLUG_CAPS, openNewPlugin, openPlugin, savePlugin, togglePlugin, deletePlugin, loadPlugins } from "../stores/admin.js";
import { ui, showView } from "../stores/ui.js";
import { fmtBytes } from "../stores/fmt.js";
import { shortAgo } from "../stores/fmt.js";

const p = computed(() => admin.plugEdit);

onMounted(() => loadPlugins());
</script>

<template>
  <section id="view-plugins" class="view plugview">
    <header class="botbar">
      <button class="icobtn" title="返回" aria-label="返回" @click="admin.plugEdit = null; showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">插件</div>
        <div class="bsub">{{ p ? (p.isNew ? "新建插件 · 保存后重启应用生效" : "编辑 " + (p.name || p.id) + " · 保存后重启应用生效") : "用户插件 · 保存后重启应用生效" }}</div>
      </div>
      <span class="flex1" />
      <button class="icobtn" title="刷新" aria-label="刷新" @click="loadPlugins()"><Icon name="refresh" :size="16" /></button>
    </header>

    <div class="swrap">
      <!-- 编辑态 -->
      <template v-if="p">
        <div class="ssec">
          <div class="ssec-head">{{ p.isNew ? "新建插件" : "编辑插件" }}<span class="flex1" /><span class="svd">{{ p.id || "—" }}</span></div>
          <label class="srow"><span class="slab">标识</span>
            <input v-model="p.id" type="text" class="grow" :disabled="!p.isNew" spellcheck="false" placeholder="plugin_1">
          </label>
          <div v-if="p.isNew" class="shint">2-40 位字母/数字/下划线/短横线，创建后不可改。</div>
          <label class="srow"><span class="slab">名称</span><input v-model="p.name" type="text" class="grow" maxlength="60"></label>
          <label class="srow"><span class="slab">说明</span><input v-model="p.description" type="text" class="grow" maxlength="500" placeholder="这个插件做什么"></label>
          <label class="srow"><span class="slab">权限</span>
            <select v-model="p.access">
              <option value="restricted">受限（推荐）</option>
              <option value="full-access">完整权限</option>
            </select>
          </label>
          <div class="shint">{{ p.access === "full-access" ? "完整权限 = 可触碰内核敏感能力，保存前会再确认。" : "受限 = 只能注册普通服务。" }}</div>
          <div v-if="p.access === 'full-access'" class="pcap">
            <label v-for="[cap, label] in PLUG_CAPS" :key="cap">
              <input v-model="p.capabilities" type="checkbox" :value="cap"> {{ label }}
            </label>
          </div>
          <label class="srow"><span class="slab">状态</span>
            <select v-model.number="p.enabled"><option :value="1">启用</option><option :value="0">停用</option></select>
          </label>
          <label class="srow"><span class="slab">入口</span>
            <input v-model="p.entry" type="text" class="grow" :disabled="!p.isNew" spellcheck="false">
          </label>
          <div class="shint">插件目录内的 .cjs 文件名。</div>
        </div>
        <div class="ssec">
          <div class="ssec-head">代码<span class="flex1" /><span class="svd">保存前会做语法检查</span></div>
          <textarea v-model="p.code" class="pcode" spellcheck="false"></textarea>
          <div class="prow">
            <button class="wbtn primary" @click="savePlugin">保存</button>
            <button class="wbtn" @click="admin.plugEdit = null">取消</button>
          </div>
        </div>
        <div class="pwarn">保存只落盘, 重启皮皮虾后插件才会被装配。代码在内核进程中运行, 请只写你理解的内容。</div>
      </template>

      <!-- 列表态 -->
      <template v-else>
        <div class="ssec">
          <div class="ssec-head">插件<span class="flex1" /><span class="svd">共 {{ admin.plugins.length }} · 启用 {{ admin.plugins.filter((x) => x.enabled).length }}</span></div>
          <div class="shint">插件放在工作区 plugins/ 目录, 每个插件一个目录: ppx.plugin.json + 入口 .cjs。保存只落盘, 重启应用后才会被装配。</div>
          <div class="prow">
            <button class="wbtn primary" @click="openNewPlugin()">新建插件</button>
            <button class="wbtn" @click="loadPlugins()">刷新</button>
          </div>
        </div>
        <div v-if="admin.pluginsErr" class="empty">加载失败：{{ admin.pluginsErr }} <button class="wbtn" @click="loadPlugins()">重试</button></div>
        <div v-else-if="!admin.plugins.length" class="empty">还没有插件。点「新建插件」写第一个。</div>
        <div v-for="pl in admin.plugins" :key="pl.id" class="pcard" :class="{ off: !pl.enabled }">
          <div class="pcard-h">
            <span class="pnm"><Icon name="plug" :size="14" />{{ pl.name || pl.id }}</span>
            <span class="ptag" :class="'acc-' + pl.access">{{ accessLabel(pl) }}</span>
            <span v-if="!pl.enabled" class="ptag off">已停用</span>
            <span v-if="pl.loose" class="ptag">散文件·只读</span>
            <span v-if="pl.error" class="ptag err">清单错误</span>
            <span v-if="pl.warning" class="ptag err">能力配置错误</span>
          </div>
          <div class="pcard-id">{{ pl.id }} · {{ pl.entry }} · {{ fmtBytes(pl.size) }}<template v-if="pl.mtime"> · {{ shortAgo(pl.mtime) }}</template></div>
          <div v-if="pl.description" class="pcard-b">{{ pl.description }}</div>
          <div v-if="pl.error" class="pcard-b perr">{{ pl.error }}</div>
          <div v-if="pl.warning" class="pcard-b perr">{{ pl.warning }}</div>
          <div v-if="!pl.loose && !pl.error" class="pacts">
            <button class="wbtn" @click="openPlugin(pl.id)">编辑</button>
            <button class="wbtn" @click="togglePlugin(pl.id, !pl.enabled)">{{ pl.enabled ? "停用" : "启用" }}</button>
            <button class="wbtn danger" @click="deletePlugin(pl.id)">删除</button>
          </div>
        </div>
        <div class="pwarn">插件代码在内核进程里运行, 等于你亲手运行的脚本。只装你读得懂的代码; 拿不准就用「受限」。</div>
      </template>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
</style>
