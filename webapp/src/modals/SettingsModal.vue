<!-- webapp/src/modals/SettingsModal.vue - 「设置」大弹窗: 通用设置 / 模型 (提供商卡片 + 二级编辑器 + 一键本地)
     2026-11-13: 通用面板的表单与保存、模型面板的交互动作已抽到 modals/settings/ 下的
     composable; 本组件只留导航 / 面板切换 / 关闭与模板。 -->
<script setup>
import { computed, onMounted, watch } from "vue";
import Icon from "../common/Icon.vue";
import { ui } from "../stores/ui.js";
import { showToast } from "../stores/toast.js";
import {
  settings, protoLabel, primaryModel, loadModelPanel, setDefault,
  toggleProvider, openEditor, closeEditor, saveEditor, fetchModels,
  quickOpen, quickDiscover, quickAttach, quickBits, quickFindConfigured,
} from "../stores/settings.js";
import { useGeneralSettings } from "./settings/useGeneralSettings.js";
import { useModelPanel } from "./settings/useModelPanel.js";
import AppearancePanel from "./settings/AppearancePanel.vue";
import { dialog, DEFAULT_WELCOME } from "../stores/dialog.js";

const panel = computed(() => settings.panel);
const provs = computed(() => settings.providers);
const ed = computed(() => settings.editor);
const q = computed(() => settings.quick);

const {
  approval, sandbox, themePref, toolRounds, asrUrl, asrKey, asrKeyPh, asrModel,
  asrState, setInfo, apprRules, savingAsr, savingRounds,
  loadGeneral, saveAsr, saveRounds, forgetRule,
  onApprovalChange, onSandboxChange, onThemeChange,
} = useGeneralSettings();
const {
  testResult, doTest, doRemove, presetOfEd, onPresetChange, onCatalogInput,
  catAdd, catDel, presetKeyHint, routingOpen, rtAux, rtPref, saveRouting,
} = useModelPanel(ed, provs);

function panelOf(v) {
  return v === "models" ? "models" : v === "appearance" ? "appearance" : v === "dialog" ? "dialog" : "general";
}

watch(() => ui.settingsModal, (v) => {
  if (!v) return;
  switchPanel(panelOf(v));
});

function switchPanel(name) {
  settings.panel = name;
  if (name === "models") loadModelPanel();
  else if (name === "general") loadGeneral();
}
function close() {
  ui.settingsModal = null;
  closeEditor();
  settings.quick.open = false;
}

onMounted(() => {
  // 首次挂载时 watch 不会对"打开时的当前值"触发 —— 初始面板必须从 ui.settingsModal 推导,
  // 不能读 settings.panel (它可能是上一次打开留下的 models/general)。
  switchPanel(panelOf(ui.settingsModal));
});
</script>

<template>
  <div class="sm-backdrop" @mousedown.self="close()">
    <div class="sm" role="dialog" aria-modal="true" aria-label="设置">
      <aside class="sm-nav">
        <div class="sm-nav-title">设置</div>
        <button class="sm-nav-item" :class="{ on: panel === 'general' }" @click="switchPanel('general')">
          <Icon name="settings" :size="14" />通用设置
        </button>
        <button class="sm-nav-item" :class="{ on: panel === 'appearance' }" @click="switchPanel('appearance')">
          <Icon name="sun" :size="14" />外观
        </button>
        <button class="sm-nav-item" :class="{ on: panel === 'dialog' }" @click="switchPanel('dialog')">
          <Icon name="brain" :size="14" />对话
        </button>
        <button class="sm-nav-item" :class="{ on: panel === 'models' }" @click="switchPanel('models')">
          <Icon name="cube" :size="14" />模型
        </button>
        <span class="flex1" />
        <button class="sm-nav-item minor" title="配置文件: 项目根 config/ppx.json (写盘自动 .bak 备份)" @click="showToast('配置文件: 项目根目录 config/ppx.json (写盘自动留 .bak 备份)')">
          <Icon name="folder-open" :size="14" />打开配置文件
        </button>
        <button class="icobtn" title="关闭" aria-label="关闭" @click="close()"><Icon name="close" :size="16" /></button>
      </aside>

      <section class="sm-body">
        <!-- 通用设置 -->
        <div v-if="panel === 'general'" class="sm-panel">
          <div class="sm-panel-head">通用设置</div>
          <div class="sm-panel-sub">审批 / 沙箱 / 语音识别</div>
          <label class="setrow">审批模式
            <select v-model="approval" @change="onApprovalChange">
              <option value="unless-trusted">unless-trusted（默认审查）</option>
              <option value="on-request">on-request（按需审批）</option>
              <option value="on-failure">on-failure（失败后审批）</option>
              <option value="never">never（全自动）</option>
            </select>
          </label>
          <label class="setrow">沙箱
            <select v-model="sandbox" @change="onSandboxChange">
              <option value="read-only">read-only（只读）</option>
              <option value="workspace-write">workspace-write（工作区可写）</option>
              <option value="danger-full-access">danger-full-access（完全访问）</option>
            </select>
          </label>
          <label class="setrow">外观
            <select v-model="themePref" @change="onThemeChange">
              <option value="system">跟随系统</option>
              <option value="light">亮色界面</option>
              <option value="dark">深色界面</option>
            </select>
          </label>
          <div class="setgroup">
            <div class="setgroup-title">工具循环</div>
            <label class="setrow">工具轮次上限
              <input v-model="toolRounds" type="number" min="1" max="64" step="1" inputmode="numeric" placeholder="24">
            </label>
            <div class="setinfo">单轮对话最多连续调用工具多少轮 (每轮可并行多个调用)。跑满后自动收口总结。</div>
            <button class="setbtn" :disabled="savingRounds" @click="saveRounds">保存工具循环设置</button>
          </div>
          <div class="setgroup">
            <div class="setgroup-title">语音识别 (云端 ASR · OpenAI 兼容 /audio/transcriptions)</div>
            <label class="setrow">服务地址<input v-model="asrUrl" type="text" placeholder="如 https://api.siliconflow.cn/v1" autocomplete="off"></label>
            <label class="setrow">API 密钥<input v-model="asrKey" type="password" :placeholder="asrKeyPh" autocomplete="new-password"></label>
            <label class="setrow">模型<input v-model="asrModel" type="text" placeholder="whisper-1 / SenseVoiceSmall 等 (默认 whisper-1)" autocomplete="off"></label>
            <button class="setbtn" :disabled="savingAsr" @click="saveAsr">保存语音配置</button>
            <div class="asr-state">{{ asrState }}</div>
          </div>
          <div class="setgroup">
            <div class="setgroup-title">已永久允许的命令</div>
            <div class="setinfo">在审批卡上点「永久允许」的命令会出现在这里，重启后仍生效。</div>
            <div v-if="apprRules === null" class="setinfo">当前服务不支持永久允许清单</div>
            <div v-else-if="!apprRules.length" class="setinfo">暂无 — 审批时点「永久允许」才会添加。</div>
            <div v-for="r in apprRules || []" :key="r.key" class="approval-rule">
              <span class="artool">{{ r.tool || "" }}</span>
              <span class="arcmd" :title="r.command || ''">{{ r.command || "" }}</span>
              <button class="forget" @click="forgetRule(r.key)">撤销</button>
            </div>
          </div>
          <div class="setinfo" id="setInfo">{{ setInfo }}</div>
        </div>

        <!-- 外观 -->
        <AppearancePanel v-else-if="panel === 'appearance'" />

        <!-- 对话流基础配置 (WorkBuddy 式): 欢迎语 / 文件修改 / 发送方式 / 过程展示 / 提示音 -->
        <div v-else-if="panel === 'dialog'" class="sm-panel">
          <div class="sm-panel-head">对话</div>
          <div class="sm-panel-sub">欢迎语 / 过程展示 / 发送方式 / 提示音 — 只影响界面呈现, 本机保存。</div>
          <div class="setgroup">
            <div class="setgroup-title">欢迎语</div>
            <label class="setrow">启用
              <span class="seg-toggle">
                <button :class="{ on: dialog.welcome.enabled }" @click="dialog.welcome.enabled = true">开</button>
                <button :class="{ on: !dialog.welcome.enabled }" @click="dialog.welcome.enabled = false">关</button>
              </span>
            </label>
            <label class="setrow col">文案
              <textarea v-model="dialog.welcome.text" rows="3" :placeholder="DEFAULT_WELCOME" spellcheck="false"></textarea>
            </label>
            <div class="setinfo">留空使用默认文案。空会话首屏显示这句话, 改完立即生效。</div>
          </div>
          <div class="setgroup">
            <div class="setgroup-title">文件修改</div>
            <label class="setrow">显示文件修改过程
              <span class="seg-toggle">
                <button :class="{ on: dialog.showFileChanges }" @click="dialog.showFileChanges = true">开</button>
                <button :class="{ on: !dialog.showFileChanges }" @click="dialog.showFileChanges = false">关</button>
              </span>
            </label>
            <div class="setinfo">关闭后 diff 卡折叠成一行摘要 (含 +x/-y 行数), 点开仍可查看完整变更。</div>
          </div>
          <div class="setgroup">
            <div class="setgroup-title">发送方式 (回合进行中发消息)</div>
            <label class="setrow">队列发送方式
              <span class="seg-toggle">
                <button :class="{ on: dialog.sendMode === 'queue' }" @click="dialog.sendMode = 'queue'">排队</button>
                <button :class="{ on: dialog.sendMode === 'immediate' }" @click="dialog.sendMode = 'immediate'">立即打断</button>
              </span>
            </label>
            <div class="setinfo">排队 = 当前回合结束后按序发送 (可撤回); 立即打断 = 中断当前回合, 立刻发送新消息。</div>
          </div>
          <div class="setgroup">
            <div class="setgroup-title">过程展示</div>
            <label class="setrow">思考与工具链
              <span class="seg-toggle">
                <button :class="{ on: dialog.processDisplay === 'concise' }" @click="dialog.processDisplay = 'concise'">简洁 · 自动收拢</button>
                <button :class="{ on: dialog.processDisplay === 'detailed' }" @click="dialog.processDisplay = 'detailed'">详细 · 平铺</button>
              </span>
            </label>
            <div class="setinfo">简洁 = 正文开始输出后把思考链收拢成一行「思考了 Xs · N 步」, 点开回看; 详细 = 全部平铺展开。</div>
          </div>
          <div class="setgroup">
            <div class="setgroup-title">提示音</div>
            <label class="setrow">回合完成提示音
              <span class="seg-toggle">
                <button :class="{ on: dialog.sound }" @click="dialog.sound = true">开</button>
                <button :class="{ on: !dialog.sound }" @click="dialog.sound = false">关</button>
              </span>
            </label>
            <div class="setinfo">回合结束且窗口不在前台时播放一声短促提示 (成功上行双音 / 失败下行三音)。</div>
          </div>
        </div>

        <!-- 模型面板 -->
        <div v-else class="sm-panel">
          <div class="sm-panel-head">模型</div>
          <div class="sm-panel-sub">填入各提供商的 API 密钥即可使用其模型。</div>
          <div v-if="settings.loadError" class="empty">{{ settings.loadError }}</div>
          <div v-else-if="!provs.length" class="empty">尚未配置模型服务<br>点下方「添加模型提供商」开始</div>
          <div v-for="(p, i) in provs" :key="p.id" class="sm-card" :class="{ def: i === 0, off: p.enabled === false }">
            <div class="sm-card-head">
              <span class="sm-dot" :data-state="p.enabled === false ? 'off' : (p.api_key_set || p.api_key_env || (presetOfEd(p.id) || {}).cloud === false ? 'ok' : 'warn')" />
              <span class="sm-name">{{ p.display_name || p.id }}</span>
              <span v-if="p.display_name && p.display_name !== p.id" class="sm-subid">{{ p.id }}</span>
              <span v-if="i === 0" class="sm-tag def"><Icon name="star" :size="10" />默认</span>
              <span class="flex1" />
              <span v-if="p.api_key_set" class="sm-tag ok"><Icon name="key" :size="11" />已登录</span>
              <span v-else-if="p.api_key_env" class="sm-tag warn" :title="'未内联保存, 运行时从环境变量 ' + p.api_key_env + ' 读取'"><Icon name="key" :size="11" />env</span>
              <span v-else-if="(presetOfEd(p.id) || {}).cloud === false" class="sm-tag ok">本地</span>
              <span v-else class="sm-tag warn"><Icon name="key" :size="11" />免 Key</span>
              <button class="btn xs" @click="openEditor(p)">编辑</button>
              <button class="btn xs danger" @click="doRemove(p)">删除</button>
            </div>
            <div class="sm-model">{{ primaryModel(p) }}</div>
            <div class="sm-meta">
              <span :title="'接口地址'">{{ p.base_url || "-" }}</span>
              <span class="sm-ctx">{{ protoLabel(p) }}</span>
              <template v-if="Array.isArray(p.models) && p.models.length">
                <span class="sm-ctx">{{ p.models.length + " 模型" + (p.models.some((m) => Array.isArray(m.inputs) && m.inputs.includes('image')) ? " · 视觉" : "") }}</span>
                <span v-if="p.models[0] && p.models[0].context_window" class="sm-ctx">{{ Math.round(p.models[0].context_window / 1024) + "K ctx" }}</span>
                <span v-if="p.models[0] && p.models[0].max_output" class="sm-ctx">{{ (p.models[0].max_output >= 1024 ? Math.round(p.models[0].max_output / 1024) + "K" : p.models[0].max_output) + " out" }}</span>
              </template>
              <span v-if="settings.usageBy[p.id] && settings.usageBy[p.id].calls" class="sm-ctx" title="本次运行累计">≈{{ settings.usageBy[p.id].calls }} 次 · {{ Math.round(settings.usageBy[p.id].tokens / 1000) }}K tok</span>
            </div>
            <div class="sm-acts">
              <button class="btn xs" @click="doTest(p)"><Icon name="activity" :size="12" />测试</button>
              <button v-if="i !== 0" class="btn xs" @click="setDefault(p.id)"><Icon name="star" :size="12" />设为默认</button>
              <button v-if="p.enabled === false" class="btn xs" @click="toggleProvider(p.id, true)"><Icon name="play" :size="12" />启用</button>
              <button v-else class="btn xs" @click="toggleProvider(p.id, false)"><Icon name="pause" :size="12" />停用</button>
              <span class="flex1" />
              <span v-if="testResult[p.id]" class="sm-result" :class="{ ok: testResult[p.id].ok, bad: !testResult[p.id].ok }">{{ testResult[p.id].text }}</span>
            </div>
          </div>

          <!-- 一键接入本地模型 -->
          <div v-if="q.open" class="sm-quick">
            <div class="sm-quick-head"><span>本机模型</span><span class="flex1" /><button class="linkbtn" @click="settings.quick.open = false">关闭</button></div>
            <div class="sm-quick-body">
              <div v-if="q.loading" class="sm-quick-hint">正在扫描 127.0.0.1 的 1234 / 11434 / 8000 / 8080 / 1337 / 5000 …</div>
              <div v-else-if="q.error" class="sm-quick-hint bad">检测失败: {{ q.error }} <button class="btn xs" @click="quickDiscover('')">重试</button></div>
              <template v-else>
                <template v-if="q.servers.filter((s2) => s2.status === 'ok' && s2.models.length).length">
                  <div v-for="(s2, si) in q.servers" :key="si">
                    <template v-if="s2.status === 'ok' && s2.models.length">
                      <div class="sm-quick-srv-head">
                        <b>{{ s2.name }}</b><span class="sm-ctx">{{ s2.base_url }}</span>
                        <span v-if="s2.meta_source === 'lmstudio-native'" class="sm-tag ok">已自动读窗口</span>
                      </div>
                      <button
 v-for="(m, mi) in s2.models" v-show="!m.embedding" :key="mi" class="sm-quick-model"
                        :class="{ on: q.sel && q.sel.si === si && q.sel.mi === mi }" @click="settings.quick.sel = { si, mi }"
                      >
                        <span class="qmn">{{ m.id }}</span>
                        <span v-if="quickBits(s2, m).length" class="qmb">{{ quickBits(s2, m).join(" · ") }}</span>
                      </button>
                    </template>
                  </div>
                  <div v-if="q.servers.some((s2) => s2.status === 'auth')" class="sm-quick-hint">
                    还有 {{ q.servers.filter((s2) => s2.status === 'auth').map((s2) => s2.name).join(" / ") }} 需要 Key。在下面填 Key 后点「检测」。
                  </div>
                </template>
                <div v-else class="sm-quick-hint">
                  {{ q.servers.some((s2) => s2.status === 'auth')
                    ? "检测到 " + q.servers.filter((s2) => s2.status === 'auth').map((s2) => s2.name).join(" / ") + ", 需要 API Key 才能读取模型。"
                    : "没发现本机模型服务。先启动 LM Studio (1234) / Ollama (11434) 并加载一个模型, 再重试; 也可以手动「添加模型提供商」。" }}
                </div>
                <div v-if="q.servers.some((s2) => s2.status === 'auth') || q.needsKey" class="sm-quick-key">
                  <input v-model="settings.quick.key" type="password" placeholder="本地服务的 API Key (LM Studio 新版默认要求)" autocomplete="new-password">
                  <button class="btn xs" @click="quickDiscover(settings.quick.key)">检测</button>
                </div>
              </template>
            </div>
            <div v-if="q.sel && q.servers[q.sel.si] && q.servers[q.sel.si].models[q.sel.mi]" class="sm-quick-foot">
              <span class="sm-quick-pick">{{ q.servers[q.sel.si].models[q.sel.mi].id }}</span>
              <span class="flex1" />
              <button class="btn xs primary" :disabled="!!quickFindConfigured(q.servers[q.sel.si], q.servers[q.sel.si].models[q.sel.mi]) || q.attaching" @click="quickAttach()">
                {{ quickFindConfigured(q.servers[q.sel.si], q.servers[q.sel.si].models[q.sel.mi]) ? "已接入" : "接入并测试" }}
              </button>
            </div>
          </div>
          <button class="sm-add-provider" @click="quickOpen()"><Icon name="zap" :size="14" />一键接入本地模型</button>
          <button class="sm-add-provider" @click="openEditor(null)"><Icon name="plus" :size="14" />添加模型提供商</button>

          <!-- 分层路由 -->
          <div v-if="routingOpen" class="setgroup">
            <div class="setgroup-title">分层路由</div>
            <label class="setrow">辅助模型 — 记忆提炼/摘要/压缩等非主对话调用
              <select v-model="rtAux">
                <option value="">跟随主模型 (不分流)</option>
                <option v-for="p in provs" :key="p.id" :value="p.id">{{ p.id }} · {{ primaryModel(p) }}</option>
              </select>
            </label>
            <label class="setrow">主模型优先序
              <select v-model="rtPref">
                <option value="local">本地优先 (本地模型 &gt; 云端)</option>
                <option value="cloud">云端优先 (云端真 Key &gt; 本地)</option>
              </select>
            </label>
            <div class="setinfo">辅助任务分流到便宜模型可显著省额度, 主对话质量不受影响; 未配置 = 全部跟随主模型。</div>
            <button class="setbtn" @click="saveRouting">保存路由</button>
          </div>
        </div>
      </section>
    </div>

    <!-- 二级编辑器 -->
    <div v-if="ed" class="sm-editor-backdrop">
      <div class="sm-editor" role="dialog" aria-modal="true">
        <div class="sm-ed-head"><span>{{ ed.editingId ? "编辑提供商 — " + (provs.find((x) => x.id === ed.editingId) || {}).display_name || ed.editingId : "添加模型提供商" }}</span></div>
        <div class="sm-ed-tabs">
          <button class="sm-ed-tab" :class="{ on: ed.tab === 'preset' }" @click="ed.tab = 'preset'">第三方模型提供商</button>
          <button class="sm-ed-tab" :class="{ on: ed.tab === 'custom' }" @click="ed.tab = 'custom'">自定义模型 API</button>
        </div>
        <div class="sm-ed-body">
          <div class="sm-ed-hint">{{ ed.tab === "preset" ? "从内置目录选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。" : "连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。" }}</div>
          <!-- preset -->
          <div v-if="ed.tab === 'preset'" class="sm-ed-group">
            <label class="sm-field">提供商
              <select v-model="ed.presetId" @change="onPresetChange">
                <option v-for="p in settings.presets" :key="p.id" :value="p.id">{{ (p.label || p.id) + (p.cloud === false ? " · 本地" : "") }}</option>
              </select>
            </label>
            <label class="sm-field">API 密钥
              <input v-model="ed.key" type="password" placeholder="密钥仅写入本机 config/ppx.json, 不回传浏览器" autocomplete="new-password">
            </label>
            <div class="sm-field-hint">{{ presetKeyHint() }}</div>
            <details class="sm-adv">
              <summary>自定义设置</summary>
              <label class="sm-field">API 地址<input v-model="ed.baseP" type="text" placeholder="由提供方配置地址" spellcheck="false" @input="ed.presetBaseTouched = true"></label>
              <label class="sm-field">超时 (ms)<input v-model="ed.timeout" type="number" min="1000" step="1000" placeholder="60000"></label>
            </details>
          </div>
          <!-- custom -->
          <div v-else class="sm-ed-group">
            <label class="sm-field">Provider ID<input v-model="ed.id" type="text" placeholder="如 acme-gateway" spellcheck="false"></label>
            <div class="sm-field-hint">以小写字母开头的标识，在请求中唯一标识该提供商。</div>
            <label class="sm-field">显示名称<input v-model="ed.displayName" type="text" placeholder="显示名称" spellcheck="false"></label>
            <label class="sm-field">API 地址<input v-model="ed.base" type="text" placeholder="https://gateway.example/v1" spellcheck="false"></label>
            <label class="sm-field">API 协议
              <select v-model="ed.protocol">
                <option v-for="(label, id) in (settings.protocols || {})" :key="id" :value="id">{{ label }}</option>
                <option v-if="!Object.keys(settings.protocols || {}).length" value="openai-completions">OpenAI Chat Completions</option>
              </select>
            </label>
            <label class="sm-field">API 密钥<input v-model="ed.keyC" type="password" placeholder="输入 API 密钥" autocomplete="new-password"></label>
          </div>
          <!-- 模型目录 -->
          <div class="sm-catalog">
            <div class="sm-cat-head">
              <span>模型目录</span>
              <span class="flex1" />
              <button type="button" class="linkbtn" :disabled="ed.fetching" @click="fetchModels">{{ ed.fetching ? "拉取中…" : "获取可用模型" }}</button>
            </div>
            <div class="sm-cat-hint">{{ ed.catHint }}</div>
            <div class="sm-cat-rows">
              <div v-if="!ed.catalog.length" class="sm-cat-empty">目录为空 —— 可「获取可用模型」拉取, 或手动添加。</div>
              <div v-for="(m, i) in ed.catalog" :key="i" class="sm-row">
                <input class="sm-ri sm-ri-id" :value="m.id" placeholder="模型 ID, 如 deepseek-chat" spellcheck="false" @input="onCatalogInput(m, 'id', $event)">
                <input class="sm-ri sm-ri-label" :value="m.label" placeholder="显示名称" spellcheck="false" @input="onCatalogInput(m, 'label', $event)">
                <input class="sm-ri sm-ri-ctx" :value="m.context_window || ''" type="number" min="1024" step="1024" placeholder="上下文窗口" @input="onCatalogInput(m, 'ctx', $event)">
                <input class="sm-ri sm-ri-out" :value="m.max_output || ''" type="number" min="16" step="1024" placeholder="最大输出" @input="onCatalogInput(m, 'out', $event)">
                <label class="sm-chk" title="所有模型均支持文本输入"><input type="checkbox" checked disabled>文本</label>
                <label class="sm-chk"><input type="checkbox" :checked="(m.inputs || []).includes('image')" @change="onCatalogInput(m, 'img', $event)">图片</label>
                <button type="button" class="sm-row-del" title="删除该模型" @click="catDel(i)"><Icon name="trash" :size="13" /></button>
              </div>
            </div>
            <button type="button" class="sm-cat-add" @click="catAdd">＋ 添加模型</button>
          </div>
          <div v-if="ed.msg" class="sm-ed-msg" :class="ed.msgKind">{{ ed.msg }}</div>
        </div>
        <div class="sm-ed-foot">
          <button class="btn" @click="closeEditor">取消</button>
          <button class="btn primary" :disabled="ed.saving" @click="saveEditor">{{ ed.editingId ? "保存" : "创建提供商" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sm-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: var(--scrim, rgba(8, 8, 12, 0.55)); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
}
.sm {
  width: min(860px, calc(100vw - 40px)); height: min(620px, calc(100vh - 60px));
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-3); display: flex; overflow: hidden;
}
.sm-nav { width: 180px; flex: none; border-right: 1px solid var(--border-soft); padding: 14px 10px; display: flex; flex-direction: column; gap: 3px; }
.sm-nav-title { font-weight: 700; font-size: 14px; padding: 0 8px 10px; }
.sm-nav-item {
  display: flex; align-items: center; gap: 8px;
  border: none; background: none; color: var(--text-2); cursor: pointer;
  padding: 7px 10px; border-radius: var(--r-sm); font-size: 12.8px; text-align: left;
}
.sm-nav-item:hover { background: var(--surface-2); color: var(--text); }
.sm-nav-item.on { background: var(--accent-soft); color: var(--accent); }
.sm-nav-item.minor { margin-top: auto; color: var(--text-4); font-size: 11.5px; }
.sm-body { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; }
.sm-panel-head { font-weight: 700; font-size: 15px; }
.sm-panel-sub { font-size: 11.5px; color: var(--text-3); margin: 2px 0 14px; }
.setrow { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12.8px; color: var(--text-2); }
.setrow input, .setrow select { flex: 1; min-width: 0; }
.setgroup { border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: 10px 14px; margin-top: 12px; }
.setgroup-title { font-weight: 650; font-size: 12.5px; margin-bottom: 4px; }
.seg-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; flex: none; }
.seg-toggle button {
  border: none; background: var(--surface-2); color: var(--text-3);
  font-size: 12px; padding: 3px 12px; cursor: pointer;
}
.seg-toggle button + button { border-left: 1px solid var(--border); }
.seg-toggle button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.setrow.col { flex-direction: column; align-items: stretch; }
.setrow textarea {
  width: 100%; font-size: 12.5px; line-height: 1.6; resize: vertical;
  min-height: 54px; font-family: inherit;
}
.setinfo { font-size: 11.5px; color: var(--text-4); margin: 4px 0; }
.setbtn {
  border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);
  font-size: 12px; padding: 4px 12px; border-radius: var(--r-sm); cursor: pointer; margin-top: 4px;
}
.setbtn:hover { background: var(--accent); color: var(--on-accent); }
.setbtn:disabled { opacity: 0.5; cursor: not-allowed; }
.asr-state { font-size: 11.5px; color: var(--text-3); margin-top: 5px; }
.approval-rule { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
.artool { color: var(--accent); font-family: ui-monospace, Consolas, monospace; flex: none; }
.arcmd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; color: var(--text-2); }
.forget { border: none; background: none; color: var(--err); cursor: pointer; font-size: 11.5px; }
.forget:hover { text-decoration: underline; }
/* 提供商卡片 */
.sm-card { border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: 10px 14px; margin-bottom: 8px; }
.sm-card.def { border-color: var(--accent-border); }
.sm-card.off { opacity: 0.6; }
.sm-card-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sm-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-4); flex: none; }
.sm-dot[data-state="ok"] { background: var(--ok); }
.sm-dot[data-state="warn"] { background: var(--warn); }
.sm-dot[data-state="off"] { background: var(--text-4); }
.sm-name { font-weight: 650; font-size: 13px; }
.sm-subid { font-size: 10.5px; color: var(--text-4); }
.sm-tag { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; background: var(--surface-3); color: var(--text-3); }
.sm-tag.ok { background: var(--ok-soft); color: var(--ok); }
.sm-tag.warn { background: var(--warn-soft); color: var(--warn); }
.sm-tag.def { background: var(--accent-soft); color: var(--accent); }
.sm-model { font-size: 12.5px; margin-top: 4px; color: var(--text); }
.sm-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--text-4); margin-top: 3px; }
.sm-acts { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
.sm-result { font-size: 11.5px; }
.sm-result.ok { color: var(--ok); }
.sm-result.bad { color: var(--err); }
.sm-add-provider {
  display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%;
  border: 1px dashed var(--border); background: none; color: var(--text-3);
  border-radius: var(--r-md); padding: 9px; cursor: pointer; font-size: 12.5px; margin-top: 8px;
}
.sm-add-provider:hover { color: var(--accent); border-color: var(--accent-border); }
/* 一键本地 */
.sm-quick { border: 1px solid var(--accent-border); border-radius: var(--r-md); padding: 10px 14px; margin-top: 10px; background: var(--accent-soft); }
.sm-quick-head { display: flex; align-items: center; font-weight: 650; font-size: 12.5px; }
.sm-quick-body { margin-top: 6px; max-height: 240px; overflow-y: auto; }
.sm-quick-hint { font-size: 12px; color: var(--text-3); padding: 6px 0; }
.sm-quick-hint.bad { color: var(--err); }
.sm-quick-srv-head { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 6px 0 3px; }
.sm-quick-model {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  border: 1px solid var(--border-soft); background: var(--surface);
  border-radius: var(--r-sm); padding: 5px 10px; cursor: pointer; margin-bottom: 3px;
  font-size: 12px; color: var(--text-2); text-align: left;
}
.sm-quick-model.on { border-color: var(--accent); }
.sm-quick-model .qmn { font-family: ui-monospace, Consolas, monospace; }
.sm-quick-model .qmb { font-size: 10.5px; color: var(--text-4); }
.sm-quick-key { display: flex; gap: 6px; margin-top: 6px; }
.sm-quick-key input { flex: 1; }
.sm-quick-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.sm-quick-pick { font-size: 12px; font-family: ui-monospace, Consolas, monospace; color: var(--accent); }
/* 二级编辑器 */
.sm-editor-backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(8, 8, 12, 0.5); display: flex; align-items: center; justify-content: center; }
.sm-editor {
  width: min(620px, calc(100vw - 40px)); max-height: calc(100vh - 80px);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-3); display: flex; flex-direction: column; overflow: hidden;
}
.sm-ed-head { padding: 12px 16px; font-weight: 700; font-size: 14px; border-bottom: 1px solid var(--border-soft); }
.sm-ed-tabs { display: flex; gap: 2px; padding: 8px 16px 0; }
.sm-ed-tab { border: none; background: none; color: var(--text-3); cursor: pointer; padding: 5px 12px; border-radius: var(--r-sm) var(--r-sm) 0 0; font-size: 12.5px; border-bottom: 2px solid transparent; }
.sm-ed-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.sm-ed-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.sm-ed-hint { font-size: 11.5px; color: var(--text-3); margin-bottom: 10px; }
.sm-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--text-2); margin-bottom: 8px; }
.sm-field input, .sm-field select { width: 100%; }
.sm-field-hint { font-size: 11px; color: var(--text-4); margin: -4px 0 8px; }
.sm-adv summary { font-size: 12px; color: var(--text-3); cursor: pointer; margin-bottom: 6px; }
.sm-catalog { border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: 10px 12px; margin-top: 10px; }
.sm-cat-head { display: flex; align-items: center; font-weight: 650; font-size: 12.5px; }
.sm-cat-hint { font-size: 11px; color: var(--text-4); margin: 3px 0 8px; }
.sm-cat-rows { display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow-y: auto; }
.sm-cat-empty { font-size: 11.5px; color: var(--text-4); padding: 6px 0; }
.sm-row { display: flex; align-items: center; gap: 5px; }
.sm-ri { font-size: 11.5px; padding: 4px 7px; }
.sm-ri-id { flex: 2; } .sm-ri-label { flex: 1.5; } .sm-ri-ctx { flex: 1; } .sm-ri-out { flex: 1; }
.sm-chk { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--text-3); flex: none; }
.sm-row-del { border: none; background: none; color: var(--text-4); cursor: pointer; display: flex; flex: none; }
.sm-row-del:hover { color: var(--err); }
.sm-cat-add { border: 1px dashed var(--border); background: none; color: var(--text-3); border-radius: var(--r-sm); padding: 5px; width: 100%; cursor: pointer; font-size: 11.5px; margin-top: 6px; }
.sm-cat-add:hover { color: var(--accent); }
.sm-ed-msg { font-size: 12px; padding: 6px 0; }
.sm-ed-msg.bad { color: var(--err); }
.sm-ed-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border-soft); }
.flex1 { flex: 1; }
</style>
