const { Plugin, Dialog, showMessage, fetchPost } = require("siyuan");

const DEFAULT_SETTINGS = {
  enabled: true,
  proxyBase: "",
  proxyPort: 8765,
  token: "",
  height: 520,
};

const BVID_RE = /BV[0-9A-Za-z]{10}/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

class BilibiliEmbedPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData("settings.json")) || {});
    if (this.settings.enabled === undefined) this.settings.enabled = true;
    this.fixTimer = null;

    this.addCommand({
      langKey: "insertBilibili",
      hotkey: "",
      editorCallback: (protyle) => this.openInsertDialog(protyle),
    });
    this.addCommand({
      langKey: "settings",
      hotkey: "",
      callback: () => this.openSettingsDialog(),
    });
    this.addCommand({
      langKey: "proxyStatus",
      hotkey: "",
      callback: () => this.showProxyStatus(),
    });
    this.addCommand({
      langKey: "reloadVideos",
      hotkey: "",
      callback: () => {
        this.reloadVideos();
        showMessage("已刷新当前文档中的 B 站播放器");
      },
    });

    this.eventBus.on("loaded-protyle-static", () => this.scheduleFix());
    this.eventBus.on("loaded-protyle-dynamic", () => this.scheduleFix());

    this.observer = new MutationObserver(() => this.scheduleFix());
    this.observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => this.fixIframes(), 500);
  }

  onunload() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.fixTimer) {
      clearTimeout(this.fixTimer);
      this.fixTimer = null;
    }
  }

  scheduleFix() {
    if (this.fixTimer) clearTimeout(this.fixTimer);
    this.fixTimer = window.setTimeout(() => this.fixIframes(), 150);
  }

  proxyBase() {
    const configured = trimBase(this.settings.proxyBase);
    if (configured) return configured;
    const host = location.hostname || "127.0.0.1";
    return `http://${host}:${Number(this.settings.proxyPort) || 8765}`;
  }

  embedUrl(bvid, page = 1, quality = 0) {
    const params = new URLSearchParams();
    params.set("p", String(Math.max(1, Number(page) || 1)));
    const q = Number(quality || 0);
    if (q > 0) params.set("height", String(q));
    return `${this.proxyBase()}/embed/${encodeURIComponent(bvid)}?${params.toString()}`;
  }

  fixIframes() {
    if (this.settings.enabled === false) return;
    const base = this.proxyBase();
    document.querySelectorAll('.protyle-wysiwyg [data-type="NodeIFrame"] iframe').forEach((iframe) => {
      const src = iframe.getAttribute("src") || "";
      if (!/\/embed\/BV[0-9A-Za-z]{10}/.test(src)) return;
      try {
        const url = new URL(src, location.href);
        const target = new URL(base);
        url.protocol = target.protocol;
        url.host = target.host;
        if (this.settings.token) url.searchParams.set("token", this.settings.token);
        const next = url.toString();
        if (next !== src) iframe.setAttribute("src", next);
      } catch (error) {
        console.warn("[bilibili-embed] rewrite failed", src, error);
      }
    });
  }

  async getProxyStatus() {
    const url = `${this.proxyBase()}/health`;
    try {
      const response = await fetch(url, {cache: "no-store"});
      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        data = {};
      }
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const cookie = data.has_cookie ? `已读取 ${data.cookie_count || 0} 个 Cookie` : "无 Cookie（公开视频仍可用）";
      return {
        ok: true,
        text: `代理已连接 · ${cookie} · ffmpeg ${data.ffmpeg ? "正常" : "缺失"}`,
        data,
      };
    } catch (error) {
      return {
        ok: false,
        text: `代理未连接：${error.message || error}`,
        data: null,
      };
    }
  }

  async showProxyStatus() {
    const status = await this.getProxyStatus();
    showMessage(status.text);
  }

  reloadVideos() {
    this.fixIframes();
    window.setTimeout(() => {
      document.querySelectorAll('.protyle-wysiwyg [data-type="NodeIFrame"] iframe').forEach((iframe) => {
        const src = iframe.getAttribute("src") || "";
        if (!/\/embed\/BV[0-9A-Za-z]{10}/.test(src)) return;
        try {
          const url = new URL(src, location.href);
          url.searchParams.set("_reload", String(Date.now()));
          iframe.setAttribute("src", url.toString());
        } catch (_) {
          // Ignore malformed third-party iframe URLs.
        }
      });
    }, 120);
  }

  currentBlockId(protyle) {
    try {
      const range = protyle.toolbar?.range || window.getSelection()?.getRangeAt(0);
      let node = range?.startContainer;
      if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
      const block = node?.closest?.("[data-node-id]");
      if (block && protyle.wysiwyg?.element?.contains(block)) return block.dataset.nodeId || "";
      const blocks = Array.from(protyle.wysiwyg?.element?.querySelectorAll(":scope > [data-node-id]") || []);
      return blocks.length ? blocks[blocks.length - 1].dataset.nodeId || "" : "";
    } catch (_) {
      return "";
    }
  }

  async insertVideoBlock(protyle, html) {
    const docId = protyle.background?.id || protyle.element?.dataset?.nodeId || protyle.wysiwyg?.element?.closest("[data-node-id]")?.dataset?.nodeId;
    if (!docId) throw new Error("无法获取当前文档 ID");
    const previousID = this.currentBlockId(protyle);
    const endpoint = previousID ? "/api/block/insertBlock" : "/api/block/appendBlock";
    const payload = {dataType: "markdown", data: html, parentID: docId};
    if (previousID) payload.previousID = previousID;
    const result = await new Promise((resolve) => fetchPost(endpoint, payload, resolve));
    if (!result || result.code !== 0) throw new Error(result?.msg || "插入块接口返回失败");
    try {
      protyle.reload?.();
    } catch (_) {
      // The transaction websocket usually refreshes the editor already.
    }
  }

  openInsertDialog(protyle) {
    const dialog = new Dialog({
      title: "插入 B 站视频",
      width: "560px",
      content: `
        <div class="b3-dialog__content">
          <label class="fn__flex-column" style="gap:6px;margin-bottom:12px">
            <span>B 站链接或 BV 号</span>
            <input id="biliUrl" class="b3-text-field fn__block" placeholder="https://www.bilibili.com/video/BV... 或 BV..." />
          </label>
          <div class="fn__flex" style="gap:12px">
            <label class="fn__flex-column" style="gap:6px;flex:1">
              <span>分 P</span>
              <input id="biliPage" class="b3-text-field fn__block" type="number" min="1" value="1" />
            </label>
            <label class="fn__flex-column" style="gap:6px;flex:1">
              <span>高度（px）</span>
              <input id="biliHeight" class="b3-text-field fn__block" type="number" min="240" value="${Number(this.settings.height) || 520}" />
            </label>
            <label class="fn__flex-column" style="gap:6px;flex:1">
              <span>画质</span>
              <select id="biliQuality" class="b3-select fn__block">
                <option value="0">自动</option>
                <option value="1080">1080P</option>
                <option value="720">720P</option>
                <option value="480">480P</option>
                <option value="360">360P</option>
              </select>
            </label>
          </div>
          <p class="b3-label__text" style="margin-top:12px">
            当前代理：${escapeHtml(this.proxyBase())}
          </p>
        </div>
        <div class="b3-dialog__action">
          <button class="b3-button b3-button--cancel" id="biliCancel">取消</button>
          <button class="b3-button b3-button--text" id="biliInsert">插入</button>
        </div>
      `,
    });
    const input = dialog.element.querySelector("#biliUrl");
    const pageInput = dialog.element.querySelector("#biliPage");
    const heightInput = dialog.element.querySelector("#biliHeight");
    const qualityInput = dialog.element.querySelector("#biliQuality");
    dialog.element.querySelector("#biliCancel").addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector("#biliInsert").addEventListener("click", async () => {
      const raw = (input.value || "").trim();
      const match = raw.match(BVID_RE);
      if (!match) {
        showMessage("没有识别到 BV 号");
        input.focus();
        return;
      }
      let page = Math.max(1, Number(pageInput.value) || 1);
      try {
        const parsed = new URL(raw, location.href);
        const urlPage = Number(parsed.searchParams.get("p"));
        if (urlPage > 0) page = urlPage;
      } catch (_) {
        // BV-only input is valid.
      }
      const height = Math.max(240, Number(heightInput.value) || 520);
      const quality = Math.max(0, Number(qualityInput.value) || 0);
      const bvid = match[0];
      const src = this.embedUrl(bvid, page, quality);
      const html = `<iframe src="${escapeHtml(src)}" style="width:100%;height:${height}px;border:0" allowfullscreen></iframe>`;
      try {
        await this.insertVideoBlock(protyle, html);
        dialog.destroy();
        showMessage("B 站视频已插入");
      } catch (error) {
        console.error("[bilibili-embed] insert failed", error, {protyle});
        showMessage(`插入失败：${error.message || error}`);
      }
    });
    input.focus();
  }

  async openSetting() {
    this.openSettingsDialog();
  }

  openSettingsDialog() {
    const dialog = new Dialog({
      title: "B 站视频嵌入设置",
      width: "620px",
      content: `
        <div class="b3-dialog__content">
          <label class="fn__flex" style="gap:8px;align-items:center;margin-bottom:14px">
            <input id="biliEnabled" type="checkbox" ${this.settings.enabled === false ? "" : "checked"} />
            <span>启用 B 站视频地址改写</span>
          </label>
          <div class="fn__flex" style="gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
            <button id="biliCheckProxy" class="b3-button b3-button--outline" type="button">检测代理状态</button>
            <button id="biliReloadVideos" class="b3-button b3-button--outline" type="button">刷新视频</button>
            <span id="biliProxyStatus" class="b3-label__text">检测中…</span>
          </div>
          <label class="fn__flex-column" style="gap:6px;margin-bottom:12px">
            <span>固定代理地址（留空 = 当前思源主机）</span>
            <input id="biliProxyBase" class="b3-text-field fn__block" value="${escapeHtml(this.settings.proxyBase || "")}" placeholder="例如 http://192.168.0.154:8765 或 https://bili.example.com" />
          </label>
          <div class="fn__flex" style="gap:12px;margin-bottom:12px">
            <label class="fn__flex-column" style="gap:6px;flex:1">
              <span>同主机代理端口</span>
              <input id="biliProxyPort" class="b3-text-field fn__block" type="number" min="1" value="${Number(this.settings.proxyPort) || 8765}" />
            </label>
            <label class="fn__flex-column" style="gap:6px;flex:1">
              <span>默认高度（px）</span>
              <input id="biliDefaultHeight" class="b3-text-field fn__block" type="number" min="240" value="${Number(this.settings.height) || 520}" />
            </label>
          </div>
          <label class="fn__flex-column" style="gap:6px">
            <span>代理访问 token（可留空）</span>
            <div class="fn__flex" style="gap:6px;align-items:center">
              <input id="biliToken" class="b3-text-field" style="flex:1" type="password" value="${escapeHtml(this.settings.token || "")}" />
              <button id="biliToggleToken" class="b3-button b3-button--outline" type="button" aria-label="显示 token" title="显示 token">
                <svg class="b3-button__icon"><use xlink:href="#iconEye"></use></svg>
              </button>
            </div>
          </label>
          <p class="b3-label__text" style="margin-top:12px">
            代理地址留空时，会自动使用当前思源页面的主机名。通过 192.168.0.154:6806 打开时，视频地址会自动变成 192.168.0.154:8765。
          </p>
        </div>
        <div class="b3-dialog__action">
          <button class="b3-button b3-button--cancel" id="biliSettingsCancel">取消</button>
          <button class="b3-button b3-button--text" id="biliSettingsSave">保存</button>
        </div>
      `,
    });
    const tokenInput = dialog.element.querySelector("#biliToken");
    const tokenToggle = dialog.element.querySelector("#biliToggleToken");
    tokenToggle.addEventListener("click", () => {
      const showing = tokenInput.type === "text";
      tokenInput.type = showing ? "password" : "text";
      tokenToggle.setAttribute("aria-label", showing ? "显示 token" : "隐藏 token");
      tokenToggle.setAttribute("title", showing ? "显示 token" : "隐藏 token");
      tokenToggle.querySelector("use").setAttribute("xlink:href", showing ? "#iconEye" : "#iconEyeoff");
    });

    const statusEl = dialog.element.querySelector("#biliProxyStatus");
    const updateProxyStatus = async () => {
      statusEl.textContent = "检测中…";
      statusEl.style.color = "";
      const status = await this.getProxyStatus();
      statusEl.textContent = status.text;
      statusEl.style.color = status.ok ? "var(--b3-theme-success)" : "var(--b3-theme-error)";
    };
    dialog.element.querySelector("#biliCheckProxy").addEventListener("click", updateProxyStatus);
    dialog.element.querySelector("#biliReloadVideos").addEventListener("click", () => {
      this.reloadVideos();
      showMessage("已刷新当前文档中的 B 站播放器");
    });
    updateProxyStatus();

    dialog.element.querySelector("#biliSettingsCancel").addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector("#biliSettingsSave").addEventListener("click", async () => {
      this.settings = {
        enabled: dialog.element.querySelector("#biliEnabled").checked,
        proxyBase: trimBase(dialog.element.querySelector("#biliProxyBase").value),
        proxyPort: Math.max(1, Number(dialog.element.querySelector("#biliProxyPort").value) || 8765),
        token: (dialog.element.querySelector("#biliToken").value || "").trim(),
        height: Math.max(240, Number(dialog.element.querySelector("#biliDefaultHeight").value) || 520),
      };
      await this.saveData("settings.json", this.settings);
      this.fixIframes();
      dialog.destroy();
      showMessage("设置已保存");
    });
  }
}

module.exports = BilibiliEmbedPlugin;
