// webapp/src/stores/toast.js - 全局气泡 (替代 5 个文件各写一份的 toast())
import { reactive } from "vue";

export const toast = reactive({
  show: false,
  msg: "",
  err: false,
  _tm: 0,
});

export function showToast(msg, isErr = false) {
  toast.msg = String(msg == null ? "" : msg);
  toast.err = !!isErr;
  toast.show = true;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { toast.show = false; }, 2600);
}
