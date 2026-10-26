/* Pixiv 打码助手 - service worker
 * 只做两件事：初始化默认设置；点击工具栏图标时通知当前标签页切换面板。
 */
const DEFAULTS = { brush: 44, block: 14, autoIntercept: true };

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { pxmSettings } = await chrome.storage.local.get('pxmSettings');
    if (!pxmSettings || typeof pxmSettings !== 'object') {
      await chrome.storage.local.set({ pxmSettings: DEFAULTS });
    }
  } catch (err) {
    console.warn('[Pixiv 打码助手] 初始化设置失败', err);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || tab.id < 0) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PXM_TOGGLE_PANEL' });
  } catch (err) {
    // 当前页不是 pixiv，或内容脚本尚未就绪，忽略即可。
  }
});
