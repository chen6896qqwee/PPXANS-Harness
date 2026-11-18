<!-- webapp/src/chat/Timeline.vue - 事件时间线 (用户/agent/思考/工具/审批/提问/计划/diff/错误)
     全部条目来自 chat.items 数据, 组件只渲染 —— 旧版"DOM 即状态"的根源在这里被拆除。
     2026-11-13: 滚动跟随 / 复制 / 编辑重发 / 卡片文案已抽到 timeline/useTimeline.js,
     本文件只剩模板与样式; 行为与拆出前一致 (展开/折叠仍写 item 字段)。 -->
<script setup>
import Icon from "../common/Icon.vue";
import { chat, regenerate, submitQuestion, skipQuestion } from "../stores/chat.js";
import { dialog } from "../stores/dialog.js";
import { useTimeline } from "./timeline/useTimeline.js";

const {
  el, lastUser, lastAgent, showJump, viewItems,
  onScroll, jump, copyText, onCopyClick, imgsOf,
  editing, editText, beginEdit, cancelEdit, sendEdit,
  md, fmtTs, dur, toolSummary, toolLabel, thinkBrief,
  toolLines, toolRest, toggleTool, toggleChain, onApprovalKey,
  qAnswer, qLabelOf, qDescOf, agentColor,
} = useTimeline();

/* diff 卡折叠摘要: +x / -y 行数 */
function diffStat(item) {
  let add = 0, del = 0;
  for (const l of item.lines || []) {
    if (l.cls === "add") add += 1;
    else if (l.cls === "del") del += 1;
  }
  return "+" + add + " / -" + del;
}
</script>

<template>
  <div class="tl-wrap">
    <button v-show="showJump" class="jumpbtn" @click="jump">↓ 新内容</button>
    <div ref="el" id="stream" class="stream" role="log" aria-live="polite" aria-label="对话消息" @scroll="onScroll">
      <template v-for="item in viewItems" :key="item.id">
        <!-- 用户消息 -->
        <div v-if="item.kind === 'user'" class="ev ev-user" :class="{ 'is-last': item.id === lastUser }">
          <div v-if="editing !== item.id" class="bubble">{{ item.text }}</div>
          <div v-else class="editbox">
            <textarea v-model="editText" rows="2" @keydown.enter.exact.prevent="sendEdit(item)" @keydown.esc="cancelEdit"></textarea>
            <div class="editbox-acts">
              <button class="btn xs" @click="cancelEdit">取消</button>
              <button class="btn xs primary" @click="sendEdit(item)">发送</button>
            </div>
          </div>
          <div v-if="imgsOf(item.text).length" class="msg-imgs">
            <a v-for="(p, i) in imgsOf(item.text)" :key="i" :href="'/' + encodeURI(p.replace(/^\//, ''))" target="_blank" rel="noopener">
              <img loading="lazy" :src="'/' + encodeURI(p.replace(/^\//, ''))" alt="图片">
            </a>
          </div>
          <button
            v-if="editing !== item.id && item.id === lastUser" class="msgact msgedit"
            title="编辑并重新发送" @click="beginEdit(item)"
          >
            <Icon name="edit" :size="12" />编辑
          </button>
        </div>

        <!-- Agent 回答 -->
        <div v-else-if="item.kind === 'agent'" class="ev ev-agent" :class="{ 'is-last': item.id === lastAgent, 'was-interrupted': item.interrupted }" @click="onCopyClick($event, item)">
          <div class="who">
            <span class="mark"><Icon name="mark" :size="12" /></span>皮皮虾 <span class="t">{{ fmtTs() }}</span>
            <span class="flex1" />
            <button class="msgact" title="换一个回答 (回卷到本条提问前, 原会话保留为分支)" @click="regenerate">
              <Icon name="refresh" :size="12" />重新生成
            </button>
            <button class="msgcopy" title="复制整条回复" @click="copyText(item.text || '')"><Icon name="copy" :size="12" /></button>
          </div>
          <div class="body md">
            <span v-if="item.streaming && !item.text" class="typing" role="status" aria-label="正在生成"><i /><i /><i /></span>
            <template v-else>
              <!-- eslint-disable-next-line vue/no-v-html —— renderMd 输出已经过 DOMPurify 净化 -->
              <span class="mdhtml" v-html="md(item.text)" />
              <span v-if="item.streaming" class="caret" />
            </template>
            <div v-if="item.interrupted" class="interrupted">⎿ 本轮已中断</div>
          </div>
        </div>

        <!-- 思考链路: 连续思考/工具归组, 一行头部 + 可折叠正文 (简洁模式回合结束后自动收拢) -->
        <div v-else-if="item.kind === 'chain'" class="ev ev-chain">
          <div
            class="chainrow" :class="{ open: item.open, live: item.live }"
            role="button" tabindex="0" :aria-expanded="item.open ? 'true' : 'false'"
            @click="toggleChain(item)" @keydown.enter.prevent="toggleChain(item)"
          >
            <span class="st" :class="item.live ? 'run' : 'ok'" />
            <span class="tkind">思考与执行</span>
            <span class="tbrief">{{ item.steps }} 步{{ item.tools ? " · " + item.tools + " 个工具" : "" }}</span>
            <span class="tdur">{{ item.label }}</span>
            <span class="chev"><Icon name="chev-d" :size="13" /></span>
          </div>
          <div v-if="item.open" class="chainbody">
            <template v-for="child in item.children" :key="child.id">
              <div v-if="child.kind === 'think'" class="ev ev-think">
                <details class="think" :class="{ done: child.ended }" :open="child.open">
                  <summary>
                    <span class="th-mark">✻</span>
                    <span class="tkind">思考</span>
                    <span class="tbrief">{{ thinkBrief(child) || "…" }}</span>
                    <span v-if="child.ended" class="tdur">{{ child.secs }}s</span>
                    <span class="th-chev"><Icon name="chev-d" :size="12" /></span>
                  </summary>
                  <div class="th-body">{{ child.text }}</div>
                </details>
              </div>
              <div v-else-if="child.kind === 'tool'" class="ev ev-tool">
                <div class="toolcard" :class="{ open: child.argsOpen, done: child.status !== 'run', failed: child.ok === false }">
                  <div class="head" role="button" tabindex="0" :aria-expanded="child.argsOpen ? 'true' : 'false'" @click="toggleTool(child)" @keydown.enter.prevent="toggleTool(child)" @keydown.space.prevent="toggleTool(child)">
                    <span class="st" :class="child.status" />
                    <span class="tkind">{{ toolLabel(child.tool) }}</span>
                    <span class="tbrief mono" :title="toolSummary(child)">{{ toolSummary(child) }}</span>
                    <span v-if="child.agent" class="agentchip" :style="{ background: agentColor(child.agent) }">{{ child.agent }}</span>
                    <span v-if="child.durationMs != null" class="tdur">{{ dur(child.durationMs) }}</span>
                    <span class="chev"><Icon name="chev-d" :size="13" /></span>
                  </div>
                  <div v-if="child.status !== 'run' && child.result" class="tres" :class="{ open: child.resultOpen, fail: child.ok === false }">
                    <div class="tres-body">
                      <div v-for="(line, i) in toolLines(child)" :key="i" class="tline">{{ line === "" ? " " : line }}</div>
                    </div>
                    <button v-if="toolRest(child) > 0" class="tmore" @click.stop="child.resultOpen = !child.resultOpen">
                      {{ child.resultOpen ? "收起" : "+" + toolRest(child) + " 行 · 展开" }}
                    </button>
                  </div>
                  <div v-if="child.argsOpen" class="tcbody">{{ JSON.stringify(child.args || {}, null, 2) }}</div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 审批卡 -->
        <div v-else-if="item.kind === 'approval'" class="ev ev-approval">
          <div class="approval" :class="{ done: item.done, settling: item.settling }">
            <div class="ahead">
              <Icon name="shield" :size="15" /><span>需要你的批准</span>
              <span class="akind">{{ item.kindLabel }}</span>
              <span class="flex1" />
              <span class="akeys">1 批准 · 2 拒绝 · Esc 拒绝</span>
            </div>
            <div class="abody pre">{{ item.body }}</div>
            <div v-if="item.reason" class="areason">{{ item.reason }}</div>
            <div v-if="!item.done" class="aacts">
              <button class="btn primary" data-act="approve" @click="onApprovalKey(item, 'approve')"><b class="kbd">1</b>批准</button>
              <template v-if="item.rememberable">
                <button class="btn" data-act="always" title="本会话内「完全相同的命令」不再询问 (重启后失效)" @click="onApprovalKey(item, 'always')">本会话始终允许</button>
                <button v-if="item.prefix" class="btn" :title="'本会话内所有以「' + item.prefix + '」开头的单条简单命令不再询问'" @click="onApprovalKey(item, 'prefix')">前缀放行 · {{ item.prefix }} …</button>
                <button class="btn" data-act="persist" title="永久允许相同命令 (可在 设置 → 通用设置 撤销)" @click="onApprovalKey(item, 'persist')">永久允许</button>
              </template>
              <button class="btn danger" data-act="deny" @click="onApprovalKey(item, 'deny')"><b class="kbd">2</b>拒绝</button>
            </div>
            <div v-else class="verdict">{{ item.verdict }}</div>
          </div>
        </div>

        <!-- 提问卡 -->
        <div v-else-if="item.kind === 'question'" class="ev ev-question">
          <div class="qcard" :class="{ done: item.done, settling: item.settling }">
            <div class="qhead">
              <Icon name="info" :size="15" /><span class="qtitle">需要你的回答</span>
              <span class="qcount">{{ item.qs.length }} 个问题</span>
              <span class="flex1" />
              <span class="qkeys">Enter 提交 · Esc 跳过</span>
            </div>
            <div class="qbody">
              <div v-for="(q, qi) in item.qs" :key="q.id || qi" class="qq">
                <div class="qqtxt">
                  <span v-if="q.header" class="qtag">{{ q.header }}</span>{{ q.question }}
                </div>
                <div v-if="(q.options || []).length" class="qopts">
                  <label v-for="(o, oi) in q.options" :key="oi" class="qopt">
                    <input
                      :type="q.multiSelect ? 'checkbox' : 'radio'"
                      :name="'qq-' + item.id + '-' + qi"
                      :value="qLabelOf(o)"
                      :checked="item.answers[qi] && item.answers[qi].selected.includes(qLabelOf(o))"
                      @change="qAnswer(item, qi, qLabelOf(o), $event.target.checked)"
                    >
                    <span class="qopt-main">
                      <span class="qopt-label">{{ qLabelOf(o) }}</span>
                      <span v-if="qDescOf(o)" class="qopt-desc">{{ qDescOf(o) }}</span>
                    </span>
                  </label>
                </div>
                <input
                  v-model="item.answers[qi].custom" class="qcustom" type="text"
                  :placeholder="(q.options && q.options.length) ? '或自己填一个答案 (可选)' : '输入你的回答'" aria-label="自定义回答"
                >
              </div>
            </div>
            <div v-if="!item.done" class="qacts">
              <button class="btn primary" @click="submitQuestion(item)">提交回答</button>
              <button class="btn" @click="skipQuestion(item)">跳过</button>
            </div>
            <div v-else class="verdict">{{ item.verdict }}</div>
          </div>
        </div>

        <!-- 计划卡 -->
        <div v-else-if="item.kind === 'plan'" class="ev ev-plan">
          <div class="who"><span class="mark"><Icon name="list" :size="12" /></span>计划</div>
          <!-- eslint-disable-next-line vue/no-v-html —— renderMd 输出已经过 DOMPurify 净化 -->
          <div class="plancard md" v-html="md(item.html || item.text)" />
        </div>

        <!-- 回合内计划卡 (v5.0: /events plan_updated 实时推进, 就地更新) -->
        <div v-else-if="item.kind === 'planlive'" class="ev ev-plan">
          <div class="who"><span class="mark"><Icon name="list" :size="12" /></span>当前计划</div>
          <div class="plancard planlive">
            <div v-for="(s, i) in item.steps" :key="i" class="pl-step" :data-st="s.status">
              <span class="pl-mark">{{ s.status === "done" ? "[x]" : s.status === "in_progress" ? "[~]" : "[ ]" }}</span>
              <span class="pl-title" :class="{ done: s.status === 'done', active: s.status === 'in_progress' }">{{ s.title }}</span>
            </div>
          </div>
        </div>

        <!-- diff 卡: 「显示文件修改过程」关闭时折叠成一行摘要 (可点开) -->
        <div v-else-if="item.kind === 'diff'" class="ev ev-diff">
          <div class="who"><span class="mark"><Icon name="diff" :size="12" /></span>变更</div>
          <button v-if="!dialog.showFileChanges && !item.diffOpen" class="diffsummary" @click="item.diffOpen = true">
            <Icon name="diff" :size="13" />
            <span>文件变更已折叠 · {{ diffStat(item) }} · 点开查看</span>
          </button>
          <div v-else class="diffbox">
            <div v-for="(l, i) in item.lines" :key="i" class="dline" :class="l.cls">{{ l.text }}</div>
          </div>
        </div>

        <!-- 错误: 原文 + 一句人话的下一步 (三级: 会自愈 / 需要你处理 / 需要上报) -->
        <div v-else-if="item.kind === 'error'" class="ev ev-error">
          <div class="errbox">{{ item.msg }}</div>
          <div v-if="item.hint" class="errhint">{{ item.hint }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tl-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.jumpbtn {
  position: absolute; z-index: 5; left: 50%; bottom: 8px; transform: translateX(-50%);
  border: 1px solid var(--border); background: var(--surface-3); color: var(--text);
  border-radius: 99px; padding: 4px 14px; font-size: 12px; cursor: pointer; box-shadow: var(--shadow-2);
}
.stream { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px 20px; display: flex; flex-direction: column; gap: 10px; }
.ev { max-width: 860px; width: 100%; margin: 0 auto; }
.pre { white-space: pre-wrap; }
.flex1 { flex: 1; }

/* 用户 */
.ev-user { align-self: stretch; }
.ev-user .bubble {
  background: var(--surface-2); border: 1px solid var(--border-soft);
  border-radius: var(--r-md); padding: 8px 12px; white-space: pre-wrap; word-break: break-word;
  margin-left: auto; max-width: 82%; width: fit-content;
}
.ev-user.is-last .msgedit { display: inline-flex; }
.msgact {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: none; color: var(--text-4); cursor: pointer; font-size: 11px;
  padding: 2px 6px; border-radius: 4px;
}
.msgact:hover { color: var(--text-2); background: var(--surface-2); }
.msgedit { display: none; margin: 4px 0 0 auto; }
.msg-imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; justify-content: flex-end; }
.msg-imgs img { max-width: 180px; max-height: 140px; border-radius: var(--r-sm); border: 1px solid var(--border); }
.editbox textarea { width: 100%; min-height: 60px; }
.editbox-acts { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }

/* Agent */
.ev-agent .who {
  display: flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 11.5px; margin-bottom: 4px;
}
.who .mark { color: var(--accent); display: flex; }
.msgcopy { display: inline-flex; }
.body {
  background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: var(--r-md); padding: 10px 14px;
}
.mdhtml :deep(p) { margin: 0.45em 0; }
.interrupted { color: var(--text-4); font-size: 11.5px; margin-top: 6px; }

/* ---------- 思考 / 工具: 紧凑行, 不是卡片 ----------
   一个回合动辄十几条思考与工具记录。每条都套一个带边框的卡片, 对话区就变成
   一堆盒子, 扫不动。这里改成"流水账"行: 行高约 28px、无边框、hover 才出色底,
   细节展开在行下方并缩进对齐。审批/提问/计划这些需要人动手的仍然用卡片。
   2026-11-18: 思考/工具外面再包一层 chain 组头 —— 简洁模式回合结束后整组收拢
   成一行「思考了 Xs · N 步」, 正文输出时即刻收拢, 不跟回答抢注意力。 */
.ev-think, .ev-tool { margin: 1px auto; }
.think, .toolcard {
  border: none; background: none; border-radius: 6px;
  transition: background var(--t-fast);
}
.think summary, .toolcard .head, .chainrow {
  list-style: none; display: flex; align-items: center; gap: 7px;
  padding: 3px 8px; border-radius: 6px; cursor: pointer; user-select: none;
  font-size: 12.5px; line-height: 1.7; color: var(--text-2);
}
.think summary::-webkit-details-marker { display: none; }
.think summary:hover, .toolcard .head:hover, .chainrow:hover { background: var(--surface-2); }
.think[open] summary, .toolcard.open .head, .chainrow.open { background: var(--surface-2); }

/* chain 组头 */
.ev-chain { margin: 3px auto; }
.chainrow { background: var(--surface-2); }
.chainrow.live { background: var(--accent-soft); }
.chainrow.live .tkind { color: var(--accent); }
.chainrow .chev { color: var(--text-4); display: flex; flex: none; opacity: .55; transition: transform var(--t-fast), opacity var(--t-fast); }
.chainrow:hover .chev, .chainrow.open .chev { opacity: 1; }
.chainrow.open .chev { transform: rotate(180deg); }
.chainbody { display: flex; flex-direction: column; }
.chainbody .ev-think, .chainbody .ev-tool { margin: 0 auto; }

/* diff 折叠摘要行 */
.diffsummary {
  display: flex; align-items: center; gap: 7px; width: 100%;
  border: 1px dashed var(--border); background: none; color: var(--text-3);
  border-radius: var(--r-sm); padding: 6px 10px; cursor: pointer; font-size: 12px;
  text-align: left;
}
.diffsummary:hover { color: var(--accent); border-color: var(--accent-border); }

.th-mark { color: var(--lv2); flex: none; font-size: 11px; }
/* 类型名 (思考 / 运行命令 / 查找文件) —— 人话, 不是工具 ID */
.tkind { flex: none; color: var(--text-2); font-weight: 500; }
/* 摘要 (思考首句 / 工具参数) —— 单行省略, 悬停看全 */
.tbrief {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-3); font-size: 12px;
}
.tbrief.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.th-chev { margin-left: auto; display: flex; color: var(--text-4); opacity: .55; transition: transform var(--t-fast), opacity var(--t-fast); }
.think[open] .th-chev { transform: rotate(180deg); opacity: 1; }

/* 展开区: 缩进到摘要起始位置, 与上面的行对齐成一组 */
.th-body {
  padding: 2px 10px 9px 30px; color: var(--text-3); font-size: 12px;
  white-space: pre-wrap; max-height: 240px; overflow-y: auto; line-height: 1.65;
}

.st { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--text-4); }
.st.run { background: var(--warn); animation: pulse-dot 1s infinite; }
.st.ok { background: var(--ok); }
.st.fail { background: var(--err); }
.agentchip { font-size: 10px; padding: 1px 7px; border-radius: 99px; color: #fff; flex: none; }
.tdur { font-size: 11px; color: var(--text-4); flex: none; margin-left: 2px; }
.chev { color: var(--text-4); display: flex; flex: none; opacity: .55; transition: transform var(--t-fast), opacity var(--t-fast); }
.toolcard .head:hover .chev, .toolcard.open .chev { opacity: 1; }
.toolcard.open .chev { transform: rotate(180deg); }

.tres { padding: 2px 10px 9px 30px; background: none; border: none; }
.tres.fail .tline { color: var(--err); }
.tres-body { max-height: 130px; overflow: hidden; }
.tres.open .tres-body { max-height: 420px; overflow-y: auto; }
.tline { font-family: ui-monospace, Consolas, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; color: var(--text-3); }
.tmore {
  border: none; background: none; color: var(--accent); cursor: pointer; font-size: 11px;
  padding: 3px 0 0; display: block;
}
.tcbody {
  padding: 2px 10px 9px 30px;
  font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--text-3);
  white-space: pre-wrap; max-height: 200px; overflow: auto;
}

/* 审批卡 */
.approval { border: 1px solid var(--warn); border-radius: var(--r-md); background: var(--warn-soft); padding: 10px 14px; }
.approval.done { border-color: var(--border-soft); background: var(--surface-2); }
.ahead { display: flex; align-items: center; gap: 7px; color: var(--warn); font-weight: 650; font-size: 13px; }
.approval.done .ahead { color: var(--text-3); }
.akind {
  font-size: 10.5px; border: 1px solid currentColor; border-radius: 4px;
  padding: 0 6px; font-weight: 500;
}
.akeys { font-size: 11px; color: var(--text-3); font-weight: 400; }
.abody {
  margin: 8px 0 0; font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  color: var(--text-2); max-height: 200px; overflow: auto;
  background: var(--surface); border-radius: var(--r-sm); padding: 8px 10px;
}
.areason { margin-top: 6px; font-size: 11.5px; color: var(--text-3); }
.aacts { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.verdict { margin-top: 8px; font-size: 12px; color: var(--text-2); }

/* 提问卡 */
.qcard { border: 1px solid var(--info); border-radius: var(--r-md); background: var(--info-soft); padding: 10px 14px; }
.qcard.done { border-color: var(--border-soft); background: var(--surface-2); }
.qhead { display: flex; align-items: center; gap: 7px; color: var(--info); font-weight: 650; font-size: 13px; }
.qcard.done .qhead { color: var(--text-3); }
.qcount { font-size: 11px; font-weight: 400; }
.qkeys { font-size: 11px; color: var(--text-3); font-weight: 400; margin-left: auto; }
.qq { margin-top: 10px; }
.qqtxt { font-size: 13px; }
.qtag {
  font-size: 10.5px; background: var(--surface-3); border-radius: 4px; padding: 1px 6px;
  margin-right: 6px; color: var(--text-2);
}
.qopts { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.qopt {
  display: flex; align-items: flex-start; gap: 8px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--r-sm);
  padding: 6px 10px; transition: border-color var(--t-fast);
}
.qopt:hover { border-color: var(--info); }
.qopt input { margin-top: 3px; accent-color: var(--accent); }
.qopt-main { display: flex; flex-direction: column; }
.qopt-label { font-size: 12.5px; }
.qopt-desc { font-size: 11px; color: var(--text-3); }
.qcustom { width: 100%; margin-top: 6px; font-size: 12.5px; }
.qacts { display: flex; gap: 7px; margin-top: 10px; }

/* 计划/diff/错误 */
.plancard { background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: 10px 14px; }
.planlive .pl-step { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; font-size: 12.8px; }
.planlive .pl-mark { color: var(--text-4); font-family: ui-monospace, Consolas, monospace; flex: none; }
.planlive .pl-step[data-st="done"] .pl-mark { color: var(--ok); }
.planlive .pl-step[data-st="in_progress"] .pl-mark { color: var(--accent); }
.planlive .pl-title.done { color: var(--text-4); text-decoration: line-through; }
.planlive .pl-title.active { color: var(--text); font-weight: 600; }
.diffbox {
  background: var(--bg-soft); border: 1px solid var(--border-soft); border-radius: var(--r-md);
  font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; max-height: 320px; overflow: auto;
}
.dline { padding: 0 10px; white-space: pre-wrap; word-break: break-all; }
.dline.add { background: var(--ok-soft); color: var(--ok); }
.dline.del { background: var(--err-soft); color: var(--err); }
.dline.hunk { color: var(--info); }
.errbox { border: 1px solid var(--err); background: var(--err-soft); color: var(--err); border-radius: var(--r-md); padding: 9px 13px; font-size: 12.5px; }
/* 下一步怎么做: 跟原文同一张卡, 但用正文色, 不让它看上去像第二段报错 */
.errhint { margin-top: 5px; padding: 0 2px; font-size: 12px; line-height: 1.6; color: var(--text-2); }
</style>
