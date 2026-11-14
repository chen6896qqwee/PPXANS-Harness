<!-- webapp/src/views/McpView.vue - MCP 服务器管理 (保存后自动重连; 密钥只写不读) -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { admin, loadMcp, openMcpForm, saveMcp, deleteMcp, reconnectMcp } from "../stores/admin.js";
import { showView } from "../stores/ui.js";

const d = computed(() => admin.mcp || {});
const list = computed(() => d.value.servers || []);
const f = computed(() => admin.mcpForm);

onMounted(() => loadMcp());
</script>

<template>
  <section id="view-mcp" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回" aria-label="返回" @click="admin.mcpForm = null; showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">MCP 服务器</div>
        <div class="bsub">共 {{ list.length }} 个 · 已连接 {{ d.connected || 0 }} 个 · 工具 {{ d.tools || 0 }} 个 · 保存后自动重连</div>
      </div>
      <span class="flex1" />
      <button class="icobtn" title="刷新" aria-label="刷新" @click="loadMcp()"><Icon name="refresh" :size="16" /></button>
    </header>
    <div class="swrap">
      <div class="ssec">
        <div class="ssec-head">服务器<span class="flex1" /><span class="svd">{{ list.length }} 个</span></div>
        <div class="shint">MCP 服务器会把外部工具注册成与内置工具同权的能力。信任开关只对你自己确认过来源的服务器打开 —— 外部工具默认每次调用都要审批。</div>
        <div class="prow">
          <button class="wbtn primary" @click="openMcpForm(null)">添加服务器</button>
          <button class="wbtn" @click="reconnectMcp()">重新连接全部</button>
        </div>
      </div>

      <!-- 表单 -->
      <div v-if="f" class="ssec mcpform">
        <div class="ssec-head">{{ f.index != null ? "编辑 " + (f.name || "") : "添加服务器" }}<span class="flex1" /><span class="svd">保存后自动重连</span></div>
        <label class="srow"><span class="slab">名称</span><input v-model="f.name" type="text" class="grow" maxlength="64" spellcheck="false" placeholder="留空则按命令/域名推导"></label>
        <div class="shint">列表里的唯一标识; 同名 = 更新该服务器。</div>
        <label class="srow"><span class="slab">传输</span>
          <select v-model="f.transport">
            <option value="stdio">stdio (本机命令)</option>
            <option value="http">http (远程端点)</option>
          </select>
        </label>
        <label class="srow"><span class="slab">命令</span><input v-model="f.command" type="text" class="grow" spellcheck="false" placeholder="npx"></label>
        <label class="srow"><span class="slab">URL</span><input v-model="f.url" type="text" class="grow" spellcheck="false" placeholder="https://example.com/mcp"></label>
        <label class="srow col"><span class="slab">参数</span>
          <textarea v-model="f.argsText" class="mwide" rows="3" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;C:\work" />
        </label>
        <div class="shint">一行一个参数 (适合含空格的路径)。</div>
        <label class="srow col"><span class="slab">环境变量</span><textarea v-model="f.envText" class="mwide" rows="2" spellcheck="false" placeholder="API_KEY=xxx"></textarea></label>
        <div class="shint">一行一个 KEY=VALUE; 留空 = 保持原值。</div>
        <label class="srow col"><span class="slab">请求头</span><textarea v-model="f.headersText" class="mwide" rows="2" spellcheck="false" placeholder="Authorization: Bearer xxx"></textarea></label>
        <div class="shint">一行一个 Name: Value; 留空 = 保持原值。</div>
        <label class="srow"><span class="slab">工具前缀</span><input v-model="f.prefix" type="text" class="grow" maxlength="64" spellcheck="false" placeholder="留空 = 自动 <名称>__"></label>
        <label class="srow"><span class="slab">超时 (ms)</span><input v-model="f.timeout" type="number" min="1" max="600000" placeholder="60000"></label>
        <label class="srow"><span class="slab">信任</span>
          <label class="skchk"><input v-model="f.trusted" type="checkbox"> 该服务器的工具免审批</label>
        </label>
        <div v-if="f.index != null && (f.headers_set || f.env_set)" class="srow">
          <span class="slab">密钥</span>
          <label class="skchk"><input v-model="f.clearSecrets" type="checkbox"> 清除已存的请求头 / 环境变量</label>
        </div>
        <div class="prow">
          <button class="wbtn primary" data-mcpsave @click="saveMcp">保存并重连</button>
          <button class="wbtn" @click="admin.mcpForm = null">取消</button>
        </div>
      </div>

      <div v-if="admin.mcpErr" class="empty">加载失败：{{ admin.mcpErr }} <button class="wbtn" @click="loadMcp()">重试</button></div>
      <div v-else-if="!list.length" class="empty">还没有 MCP 服务器。点「添加服务器」接入 stdio 命令或 HTTP 端点。</div>
      <div v-for="(s, i) in list" :key="s.name || i" class="pcard" :class="{ off: s.status && s.status.error }">
        <div class="pcard-h">
          <span class="mst" :class="s.status && s.status.connected ? 'ok' : (s.status && s.status.error ? 'error' : 'quiet')" />
          <span class="pnm">{{ s.name || "mcp" }}</span>
          <span class="ptag">{{ s.transport }}</span>
          <span v-if="s.trusted" class="ptag acc-full-access">信任</span>
          <span v-if="s.headers_set" class="ptag">带密钥</span>
          <span v-if="s.status && s.status.connected" class="ptag">已连接</span>
          <span v-else-if="s.status && s.status.error" class="ptag err">连接失败</span>
          <span v-else class="ptag off">未连接</span>
        </div>
        <div class="pcard-id">
          {{ s.transport === "http" ? (s.url || "") : ((s.command || "") + (s.args && s.args.length ? " " + s.args.join(" ") : "")) || "—" }}
        </div>
        <div class="pcard-b">
          {{ s.status && s.status.connected ? "已连接 · " + (s.status.tools || 0) + " 个工具" : (s.status && s.status.error ? "连接失败: " + s.status.error : "尚未连接 · 保存或点「重新连接全部」后拉取工具") }}
          · 配置工具 {{ s.tools || 0 }} 个
          <template v-if="s.prefix"> · 前缀 {{ s.prefix }}</template>
          <template v-if="s.timeout"> · 超时 {{ s.timeout }}ms</template>
        </div>
        <div class="pacts">
          <button class="wbtn" @click="openMcpForm(i)">编辑</button>
          <button class="wbtn danger" @click="deleteMcp(i)">删除</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
.mst { width: 9px; height: 9px; border-radius: 50%; background: var(--text-4); flex: none; }
.mst.ok { background: var(--ok); }
.mst.error { background: var(--err); }
.srow.col { align-items: flex-start; flex-direction: column; }
.srow.col .slab { width: auto; margin-bottom: 3px; }
</style>
