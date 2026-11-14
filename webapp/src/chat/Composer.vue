<!-- webapp/src/chat/Composer.vue - 输入区: 消息队列/附件/语音/@引用/命令面板/模型座椅/权限座椅/状态条
     2026-11-13: 模型座椅 / 权限范围 / 语音输入 / 状态条 四块逻辑已抽到 composer/ 下的
     composable, 本组件只留编排 (键盘优先级 / 发送 / 附件 / 浮层互斥)。 -->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../common/Icon.vue";
import {
  chat, send, stopGen, uploadFile, isImagePath, histStep, PERM_LEVELS,
  applyPerm, llmSwitch, REASON_LABELS, footHint,
} from "../stores/chat.js";
import { showToast } from "../stores/toast.js";
import { ui } from "../stores/ui.js";
import { useComposerPanels } from "./composer/useComposerPanels.js";
import { useModelSeat } from "./composer/useModelSeat.js";
import { usePermissionScope } from "./composer/usePermissionScope.js";
import { useVoiceInput } from "./composer/useVoiceInput.js";
import { useStatusBar } from "./composer/useStatusBar.js";

const inp = ref(null);
const fileInput = ref(null);

/* ---------- 自动伸缩 ---------- */
function autosize() {
  const i = inp.value;
  if (!i) return;
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight, 180) + "px";
}
watch(() => chat.input, () => nextTick(autosize));

const canSend = computed(() => !!(chat.input.trim() || chat.pendingFiles.length || chat.refFiles.length));

// 命令面板与 @ 引用的规则在 composer/useComposerPanels.js —— 这里只接引用, 键盘优先级仍归本组件编排
const { paletteList, pickCommand, movePalette, pickAt, moveAt, atName, atDir } = useComposerPanels(inp);

const {
  track, seatLevels, curLevel, curIdx, modelName, fillPct, fillLevel, curLevelTone,
  thumbLeft, dragIdx, onTrackDown, onTrackMove, onTrackUp, onTrackKey,
  seatPane, provs, openSeat,
} = useModelSeat();
const { curPerm, scopeText, scopeTitle, openPerm } = usePermissionScope();
const { micRec, micClick } = useVoiceInput(inp);
const { statRun, statCtx, ctxBar, statSum, hasStats } = useStatusBar();

/* ---------- 发送 / 键盘 ---------- */
function onKeydown(e) {
  // @ 引用选择器优先于斜杠命令面板与历史翻页
  if (chat.atPaletteOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveAt(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveAt(-1); return; }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      if (chat.atMatches[chat.atSel]) { pickAt(chat.atMatches[chat.atSel]); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); chat.atPaletteOpen = false; return; }
  }
  if (chat.paletteOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const c = paletteList.value[chat.paletteSel];
      if (c) { pickCommand(c); return; }
    }
    if (e.key === "Escape") { chat.paletteOpen = false; return; }
  }
  // ↑/↓ 输入历史
  if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (!chat.input || (inp.value.selectionStart === 0 && inp.value.selectionEnd === 0)) {
      e.preventDefault();
      histStep(-1, (t) => { chat.input = t; });
      return;
    }
  }
  if (e.key === "ArrowDown" && chat.hist.idx !== -1 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    histStep(1, (t) => { chat.input = t; });
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function onSendClick() {
  if (chat.streaming) stopGen();
  else send();
}

/* ---------- 附件 ---------- */
function pickFiles() { fileInput.value && fileInput.value.click(); }
function onFiles(e) {
  Array.prototype.forEach.call(e.target.files || [], uploadFile);
  e.target.value = "";
}
function onPaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.indexOf("image/") === 0) {
      e.preventDefault();
      const f = it.getAsFile();
      if (f) uploadFile(new File([f], "paste-" + Date.now() + ".png", { type: f.type }));
    }
  }
}
function onDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  Array.prototype.forEach.call((e.dataTransfer && e.dataTransfer.files) || [], uploadFile);
}
const dragOver = ref(false);
function removePending(i) { chat.pendingFiles.splice(i, 1); }
function removeRef(i) { chat.refFiles.splice(i, 1); }

/* ---------- 队列 ---------- */
function withdraw(i) { chat.queue.splice(i, 1); showToast("已撤回排队消息"); }

/* 点击外部关闭浮层 */
function onDocPointer(e) {
  if (chat.seatOpen && !e.target.closest(".seatcard") && !e.target.closest(".seat")) chat.seatOpen = false;
  if (chat.permOpen && !e.target.closest(".permcard") && !e.target.closest(".permseat")) chat.permOpen = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointer);
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointer));

function openModels() {
  chat.seatOpen = false;
  ui.settingsModal = "models";
}
</script>

<template>
  <div class="composer-wrap">    <!-- 命令面板 -->
    <div v-show="chat.paletteOpen" class="palette" role="dialog" aria-label="命令面板">
      <button
        v-for="(c, i) in paletteList" :key="c.name" class="pitem" :class="{ sel: i === chat.paletteSel }"
        @mouseenter="chat.paletteSel = i" @click="pickCommand(c)"
      >
        <span class="pname">/{{ c.name }}</span>
        <span class="pdesc">{{ c.description || "" }}</span>
        <span v-if="c.argumentHint" class="phint">{{ c.argumentHint }}</span>
      </button>
    </div>
    <!-- @ 文件引用 -->
    <div v-show="chat.atPaletteOpen" class="palette at-palette" role="dialog" aria-label="引用工作区文件">
      <button
        v-for="(p, i) in chat.atMatches" :key="p" class="pitem atitem" :class="{ sel: i === chat.atSel }"
        @mouseenter="chat.atSel = i" @click="pickAt(p)"
      >
        <span class="pname">{{ atName(p) }}</span>
        <span v-if="atDir(p)" class="pdesc">{{ atDir(p) }}</span>
      </button>
    </div>
    <!-- 排队消息 -->
    <div v-show="chat.queue.length" class="queue" role="list" aria-label="排队中的消息">
      <div v-for="(q, i) in chat.queue" :key="i" class="qitem">
        <span class="qidx">{{ i + 1 }}</span>
        <span class="qtext" :title="q.text">{{ q.label }}</span>
        <button title="撤回这条" aria-label="撤回排队消息" @click="withdraw(i)"><Icon name="close" :size="11" /></button>
      </div>
    </div>

    <div id="composer" class="composer" :class="{ busy: chat.streaming, drag: dragOver }" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop="onDrop">
      <div v-show="chat.pendingFiles.length || chat.refFiles.length" class="attchips">
        <span v-for="(p, i) in chat.pendingFiles" :key="'u' + i" class="attchip" :class="{ file: !isImagePath(p) }">
          <img v-if="isImagePath(p)" :src="'/' + encodeURI(p)" alt="">
          <span v-else class="fico"><Icon name="file" :size="13" /></span>
          <i :title="p">{{ p.split("/").pop() }}</i>
          <button title="移除" @click="removePending(i)"><Icon name="close" :size="11" /></button>
        </span>
        <span v-for="(p, i) in chat.refFiles" :key="'r' + i" class="attchip file refchip" :title="p">
          <span class="fico">@</span><i>{{ p.split("/").pop() }}</i>
          <button title="移除引用" @click="removeRef(i)"><Icon name="close" :size="11" /></button>
        </span>
      </div>
      <textarea
 id="inp" ref="inp" v-model="chat.input" rows="1"
        placeholder="发消息或创建任务，/ 调用指令" @keydown="onKeydown" @paste="onPaste" />
      <div class="crow">
        <div class="tleft">
          <button class="icobtn att" title="上传文件 (图片 / 文档 / 代码 / 压缩包等)" aria-label="上传文件" @click="pickFiles">
            <Icon name="plus" :size="17" />
          </button>
          <input ref="fileInput" type="file" multiple hidden @change="onFiles">
          <button class="seat permseat" :data-tone="curPerm.tone" title="权限范围 · 沙箱与审批" @click.stop="openPerm">
            <Icon name="shield" :size="14" />
            <em>{{ curPerm.label }}</em>
            <Icon class="chev" name="chev-d" :size="12" />
          </button>
        </div>
        <div class="tright">
          <button class="seat" title="模型与思考强度" @click.stop="openSeat">
            <em>{{ chat.llm && chat.llm.current ? (chat.llm.current.model || chat.llm.current.id) : (chat.llm ? "未配置模型" : "—") }}</em>
            <span class="seat-badge" :data-lv="curLevelTone">{{ REASON_LABELS[curLevel] || curLevel }}</span>
            <Icon class="chev" name="chev-d" :size="12" />
          </button>
          <button class="icobtn mic" :class="{ rec: micRec }" title="语音输入 (轻点开始/结束)" aria-label="语音输入" @click="micClick">
            <Icon name="mic" :size="16" />
          </button>
          <button id="btnSend" class="send" :class="{ stop: chat.streaming }" :disabled="chat.streaming ? false : !canSend"
            :title="chat.streaming ? '停止生成 (Esc)' : '发送 (Enter)'" aria-label="发送 (Enter)" @click="onSendClick">
            <Icon :name="chat.streaming ? 'stop-dot' : 'send'" :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- 模型 + 思考强度座椅卡片 -->
    <div v-if="chat.seatOpen" class="seatcard" role="dialog" aria-label="模型与思考强度">
      <template v-if="seatPane === 'root'">
        <button class="rs-row" @click="seatPane = 'model'">
          <span class="rs-row-label">模型</span>
          <span class="rs-row-name">{{ modelName }}</span>
          <Icon class="rs-row-chev" name="chev-r" :size="13" />
        </button>
        <div class="rs-effort">
          <div class="rs-effort-head">
            <span class="rs-effort-title">思考强度</span>
            <span class="rs-effort-value" :data-lv="fillLevel">{{ REASON_LABELS[(dragIdx >= 0 ? seatLevels[dragIdx] : curLevel)] || curLevel }}</span>
          </div>
          <div
 ref="track" class="rs-track" :data-level="fillLevel" role="slider" tabindex="0"
            :aria-label="'思考强度'" :aria-valuemin="0" :aria-valuemax="seatLevels.length - 1" :aria-valuenow="curIdx"
            @pointerdown="onTrackDown" @pointermove="onTrackMove" @pointerup="onTrackUp" @pointercancel="onTrackUp" @keydown="onTrackKey"
          >
            <div class="rs-dots" aria-hidden="true">
              <i v-for="di in seatLevels.length - 1" :key="di" class="rs-dot" :style="{ left: 6 + (di / (seatLevels.length - 1)) * 88 + '%' }" />
            </div>
            <div class="rs-fill" v-if="fillPct > 0" :data-level="fillLevel" :style="{ width: fillPct + 'px' }" />
            <div class="rs-thumb" :style="{ left: thumbLeft + 'px' }" />
          </div>
        </div>
        <div class="pop-hint">按厂商能力注入: 智谱/方舟 thinking、通义 enable_thinking、OpenAI reasoning_effort; 未支持的模型自动忽略。</div>
      </template>
      <template v-else>
        <button class="rs-back" @click="seatPane = 'root'"><Icon name="chev-r" :size="13" /><span>模型</span></button>
        <div v-if="!provs.length" class="rs-status">{{ chat.llm ? "未配置任何 provider · 到「设置 → 模型」新增" : "模型状态还在读取, 请稍后再打开" }}</div>
        <div v-for="p in provs" :key="p.id" class="rs-group">
          <div class="rs-group-name">{{ p.id }}</div>
          <button class="rs-model" :class="{ selected: p.current }" :disabled="!p.usable" @click="llmSwitch(p.id)">
            <span class="rs-model-name">{{ p.model || "(未设模型)" }}{{ p.vision ? " · 视觉" : "" }}</span>
            <span v-if="!p.usable" class="rs-model-off">未配置 Key</span>
            <Icon v-if="p.current" class="rs-check" name="check" :size="13" />
          </button>
        </div>
      </template>
    </div>

    <!-- 权限范围卡片 -->
    <div v-if="chat.permOpen" class="permcard" role="dialog" aria-label="权限范围">
      <div class="permhead">
        <span class="permhead-ic"><Icon name="shield" :size="16" /></span>
        <span class="permhead-main"><b>权限范围</b><i>决定皮皮虾能做什么、何时需要你批准</i></span>
      </div>
      <div class="permlist" role="menu">
        <button
 v-for="lv in PERM_LEVELS" :key="lv.id" class="permopt" :data-tone="lv.tone"
          :class="{ on: lv.id === curPerm.id }" role="menuitemradio" :aria-checked="lv.id === curPerm.id ? 'true' : 'false'"
          @click="applyPerm(lv.id)"
        >
          <span class="permicon"><Icon :name="lv.icon" :size="16" /></span>
          <span class="permmain">
            <span class="permlabel">{{ lv.label }}</span>
            <span class="permdesc">{{ lv.desc }}</span>
          </span>
          <span class="permcheck"><Icon v-if="lv.id === curPerm.id" name="check" :size="15" /></span>
        </button>
      </div>
      <!-- 当前实际能碰哪些目录: 档位名太抽象, 直接写出来 -->
      <div class="permrange" :title="scopeTitle">
        <Icon name="folder" :size="12" />
        <span>{{ scopeText }}</span>
      </div>
      <div class="permfoot">档位切换即时生效 · 只动内存不写配置 (重启还原) · 完全权限只建议用于可丢弃环境</div>
    </div>

    <div class="footNote">
      <span v-if="!hasStats && !chat.streaming" class="footHint">Enter 发送 · Shift+Enter 换行 · / 唤起命令面板</span>
      <span v-else class="statbar">
        <span class="stat"><em>{{ footHint }}</em></span>
        <span v-if="statRun" class="stat" title="当前会话最近一次生成的轮次 / 工具步数 / 输出速度"><Icon name="clock" :size="11" /><em>{{ statRun }}</em></span>
        <span v-if="ctxBar" class="stat" title="当前会话最近一次模型调用的用量"><Icon name="activity" :size="11" /><em>{{ ctxBar }}</em></span>
        <span v-if="statCtx" class="stat" title="上下文占用 = 最近一次调用的输入 token ÷ 模型上下文窗口"><Icon name="target" :size="11" /><em>{{ statCtx }}</em></span>
        <span v-if="statSum" class="stat" title="累计用量 (本进程启动以来)"><Icon name="bars" :size="11" /><em>{{ statSum }}</em></span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.composer-wrap { flex: none; padding: 4px 18px 10px; position: relative; max-width: 900px; width: 100%; margin: 0 auto; }
.palette {
  position: absolute; left: 18px; right: 18px; bottom: calc(100% - 2px);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); z-index: 50; max-height: 280px; overflow-y: auto; padding: 4px;
}
.pitem {
  display: flex; align-items: baseline; gap: 10px; width: 100%;
  border: none; background: none; cursor: pointer; text-align: left;
  padding: 6px 10px; border-radius: var(--r-sm); font-size: 12.5px; color: var(--text-2);
}
.pitem.sel { background: var(--accent-soft); color: var(--text); }
.pitem .pname { font-family: ui-monospace, Consolas, monospace; color: var(--accent); flex: none; }
.pitem .pdesc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pitem .phint { color: var(--text-4); font-size: 11px; flex: none; }
.queue { margin-bottom: 6px; display: flex; flex-direction: column; gap: 3px; }
.qitem {
  display: flex; align-items: center; gap: 8px;
  background: var(--surface-2); border: 1px dashed var(--border);
  border-radius: var(--r-sm); padding: 4px 10px; font-size: 12px; color: var(--text-2);
}
.qidx { color: var(--accent); font-weight: 700; }
.qtext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qitem button { border: none; background: none; color: var(--text-4); cursor: pointer; display: flex; }
.qitem button:hover { color: var(--err); }
.composer {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  padding: 8px 10px 6px; transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.composer:focus-within { border-color: var(--accent-border); box-shadow: 0 0 0 3px var(--accent-soft); }
.composer.drag { border-color: var(--accent); background: var(--accent-soft); }
.attchips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.attchip {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 3px 8px; font-size: 11.5px; color: var(--text-2);
}
.attchip img { width: 22px; height: 22px; object-fit: cover; border-radius: 4px; }
.attchip .fico { color: var(--text-4); display: flex; }
.attchip i { font-style: normal; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attchip button { border: none; background: none; color: var(--text-4); cursor: pointer; display: flex; }
.attchip button:hover { color: var(--err); }
.refchip .fico { color: var(--accent); font-weight: 700; }
textarea#inp {
  width: 100%; border: none; background: none; resize: none; outline: none;
  max-height: 180px; padding: 4px 4px 6px; line-height: 1.5; font-size: 13.5px; color: var(--text);
}
.crow { display: flex; align-items: center; gap: 6px; }
.tleft, .tright { display: flex; align-items: center; gap: 6px; }
.tright { margin-left: auto; }
.seat {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); background: var(--surface-2);
  border-radius: 99px; padding: 3px 10px; font-size: 11.5px; color: var(--text-2); cursor: pointer;
  transition: border-color var(--t-fast), color var(--t-fast);
}
.seat:hover { border-color: var(--text-4); color: var(--text); }
.seat em { font-style: normal; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seat .chev { color: var(--text-4); }
.seat-badge {
  font-size: 10px; padding: 0 6px; border-radius: 99px;
  background: var(--surface-3); color: var(--text-3);
}
.seat-badge[data-lv="1"] { background: var(--info-soft); color: var(--lv1); }
.seat-badge[data-lv="2"] { background: rgba(155, 109, 214, 0.15); color: var(--lv2); }
.seat-badge[data-lv="3"] { background: rgba(224, 95, 168, 0.15); color: var(--lv3); }
.permseat[data-tone="ro"] { color: var(--text-3); }
.permseat[data-tone="ww"] { color: var(--info); }
.permseat[data-tone="full"] { color: var(--err); }
.mic.rec { color: var(--err); animation: pulse-dot 1s infinite; }
.send {
  width: 32px; height: 32px; border-radius: 10px; border: none;
  background: var(--accent); color: var(--on-accent); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  transition: background var(--t-fast), transform var(--t-fast);
}
.send:hover { background: var(--accent-hover); }
.send:disabled { opacity: 0.4; cursor: not-allowed; }
.send:active { transform: scale(0.96); }
.send.stop { background: var(--err); }
/* 座椅卡片 (权限 / 模型)
   2026-11-08 修复: 原来是 position:fixed 且没写 top/left —— 卡片按"文档流静态位置"渲染,
   也就是永远朝着输入框下方展开。输入框贴着窗口底部, 于是卡片被窗口下沿裁掉一半
   (截图里只能看到标题那一行)。改成相对 .composer-wrap 向上弹, 和命令面板同一套逻辑:
   输入框永远在底部, 上方一定比下方有空间。 */
.seatcard, .permcard {
  position: absolute; bottom: calc(100% + 8px); z-index: 80; width: 340px;
  max-height: calc(100vh - 120px); overflow-y: auto;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-3); padding: 12px;
}
/* 左边按钮的卡片贴左, 右边按钮的卡片贴右 —— 与各自的 seat 按钮对齐 */
.permcard { left: 18px; }
.seatcard { right: 18px; }
.rs-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: none; background: none; cursor: pointer; padding: 6px 4px;
  border-radius: var(--r-sm); color: var(--text);
}
.rs-row:hover { background: var(--surface-2); }
.rs-row-label { color: var(--text-3); font-size: 11.5px; }
.rs-row-name { flex: 1; text-align: right; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-row-chev { color: var(--text-4); transform: rotate(180deg); }
.rs-effort { margin-top: 8px; }
.rs-effort-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.rs-effort-title { font-size: 12px; color: var(--text-2); }
.rs-effort-value { font-size: 12.5px; font-weight: 700; color: var(--text-3); }
.rs-effort-value[data-lv="1"] { color: var(--lv1); }
.rs-effort-value[data-lv="2"] { color: var(--lv2); }
.rs-effort-value[data-lv="3"] { color: var(--lv3); }
.rs-track {
  position: relative; height: 26px; border-radius: 13px; background: var(--surface-2);
  border: 1px solid var(--border); outline: none; cursor: pointer;
}
.rs-track:focus { border-color: var(--accent); }
.rs-dots { position: absolute; inset: 0; }
.rs-dot { position: absolute; top: 50%; width: 4px; height: 4px; border-radius: 50%; background: var(--text-4); transform: translate(-50%, -50%); }
.rs-fill {
  position: absolute; left: 1px; top: 1px; bottom: 1px; border-radius: 12px; max-width: calc(100% - 2px);
  background: linear-gradient(90deg, var(--lv1), var(--lv2), var(--lv3));
  opacity: 0.75;
}
.rs-thumb {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 22px; height: 16px; border-radius: 6px; background: var(--surface);
  border: 1.5px solid var(--accent); box-shadow: var(--shadow-1);
}
.pop-hint { margin-top: 10px; font-size: 10.5px; color: var(--text-4); line-height: 1.5; }
.rs-back { display: flex; align-items: center; gap: 4px; border: none; background: none; color: var(--text-2); cursor: pointer; padding: 4px; border-radius: 4px; }
.rs-back:hover { background: var(--surface-2); }
.rs-back svg { transform: rotate(180deg); }
.rs-status { padding: 12px 4px; color: var(--text-3); font-size: 12px; }
.rs-group { margin-top: 8px; }
.rs-group-name { font-size: 10.5px; color: var(--text-4); letter-spacing: 1px; margin-bottom: 3px; }
.rs-model {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 1px solid var(--border-soft); background: var(--surface-2);
  border-radius: var(--r-sm); padding: 6px 10px; cursor: pointer; font-size: 12.5px;
  margin-bottom: 3px; color: var(--text-2);
}
.rs-model:hover { border-color: var(--accent-border); }
.rs-model.selected { border-color: var(--accent); color: var(--text); }
.rs-model:disabled { opacity: 0.5; cursor: not-allowed; }
.rs-model-name { flex: 1; }
.rs-model-off { font-size: 10.5px; color: var(--warn); }
.rs-check { color: var(--accent); }
/* 权限卡 */
.permhead { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
.permhead-ic { color: var(--accent); display: flex; }
.permhead-main b { display: block; font-size: 13px; }
.permhead-main i { font-style: normal; font-size: 11px; color: var(--text-3); }
.permlist { display: flex; flex-direction: column; gap: 4px; }
.permopt {
  display: flex; align-items: center; gap: 10px; width: 100%;
  border: 1px solid var(--border-soft); background: var(--surface-2);
  border-radius: var(--r-sm); padding: 8px 10px; cursor: pointer; text-align: left;
}
.permopt:hover { border-color: var(--text-4); }
.permopt.on { border-color: var(--accent); background: var(--accent-soft); }
.permopt[data-tone="full"] .permlabel { color: var(--err); }
.permicon { display: flex; color: var(--text-3); }
.permmain { flex: 1; display: flex; flex-direction: column; }
.permlabel { font-size: 12.5px; font-weight: 600; }
.permdesc { font-size: 11px; color: var(--text-3); }
.permcheck { color: var(--accent); display: flex; }
.permfoot { margin-top: 10px; font-size: 10.5px; color: var(--text-4); }
.permrange {
  display: flex; align-items: center; gap: 6px; margin-top: 9px;
  padding: 6px 9px; border-radius: var(--r-sm);
  background: var(--surface-2); border: 1px solid var(--border-soft);
  font-size: 11.5px; color: var(--text-3); cursor: default;
}
.permrange svg { flex: none; color: var(--text-4); }
.permrange span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 状态条 */
.footNote { display: flex; align-items: center; gap: 12px; margin-top: 6px; padding: 0 6px; min-height: 18px; }
.footHint { font-size: 11px; color: var(--text-4); }
.statbar { display: inline-flex; gap: 14px; flex-wrap: wrap; }
.stat { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-4); }
.stat em { font-style: normal; }
</style>
