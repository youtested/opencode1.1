const sidebarApps = window.acode ? acode.require("sidebarApps") : null;
const commands = window.acode ? acode.require("commands") : null;
const PLUGIN_ID = "com.opencode.py.ide";
const DEFAULT_URL = "http://127.0.0.1:4096";

class OpenCodeIdePlugin {
  constructor() {
    this.baseUrl = DEFAULT_URL;
    this.token = "";
    this.page = null;
    this.pollTimer = null;
    this.lastContext = "";
    this.applied = {};
    this.edgeHandle = null;
  }

  async init(baseUrl, page, options) {
    this.baseUrl = (baseUrl || DEFAULT_URL).replace(/\/$/, "");
    this.page = page;
    const ctx = options && options.ctx;
    if (ctx) {
      try {
        this.baseUrl = (await ctx.getSecret("server_url")) || this.baseUrl;
        this.token = (await ctx.getSecret("server_token")) || "";
      } catch (_) {
      }
    }
    try {
      this.fetch = acode.require("fetch");
    } catch (_) {
      this.fetch = window.fetch ? window.fetch.bind(window) : null;
    }
    if (!this.token && typeof acode.prompt === "function") {
      try {
        this.baseUrl = (await acode.prompt("OpenCode server URL", this.baseUrl, "text")) || this.baseUrl;
        this.token = (await acode.prompt("OpenCode server token", "", "text")) || "";
        if (ctx) {
          await ctx.setSecret("server_url", this.baseUrl);
          await ctx.setSecret("server_token", this.token);
        }
      } catch (_) {
      }
    }
    if (commands) {
      commands.addCommand({
        name: "opencode.ide.sync",
        description: "OpenCode: sync this file",
        exec: () => { this.pushContext(true); return true; }
      });
      commands.addCommand({
        name: "opencode.ide.open",
        description: "OpenCode: send the active file to the agent",
        exec: () => { this.pushContext(true); return true; }
      });
    }
    if (sidebarApps) {
      sidebarApps.add("icon code", PLUGIN_ID, "OpenCode IDE", () => this.open(), true, () => this.open());
    }
    this.addEdgeHandle();
    this.startPolling();
  }

  addEdgeHandle() {
    if (this.edgeHandle) return;
    if (typeof document === "undefined" || !document.body || typeof document.createElement !== "function") {
      setTimeout(() => this.addEdgeHandle(), 200);
      return;
    }
    const handle = document.createElement("button");
    handle.type = "button";
    handle.textContent = "OpenCode IDE";
    handle.title = "Open OpenCode IDE";
    handle.style.cssText = "position:fixed;right:0;top:58%;z-index:2147483647;writing-mode:vertical-rl;text-orientation:mixed;border:1px solid #3fae86;border-right:0;border-radius:10px 0 0 10px;background:#0f6b57;color:#fff;font:600 12px system-ui,sans-serif;padding:12px 4px;box-shadow:0 4px 14px #0008;cursor:pointer";
    handle.onclick = () => this.open();
    document.body.appendChild(handle);
    this.edgeHandle = handle;
  }

  open() {
    try {
      const command = window.acode && acode.require("command");
      if (command && typeof command.executeCommand === "function") {
        command.executeCommand("opencode.agent.open");
        return;
      }
    } catch (_) {
    }
    if (this.page && typeof this.page.show === "function") this.page.show();
    this.pushContext(true);
  }

  authHeaders() {
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (this.token) headers["Authorization"] = "Bearer " + this.token;
    return headers;
  }

  async pushContext(force) {
    try {
      const file = window.editorManager && window.editorManager.activeFile;
      if (!file) return;
      const path = file.path || file.name || "";
      const content = await this.readActiveFile();
      const line = this.cursorLine(file);
      const ctx = { path, uri: file.uri || "", language: this.languageOf(path), line, character: 0, content };
      const key = path + ":" + line + ":" + content.length;
      if (!force && key === this.lastContext) return;
      this.lastContext = key;
      await this.fetch(this.baseUrl + "/api/v1/ide/context", {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(ctx)
      });
    } catch (_) {
    }
  }

  async readActiveFile() {
    try {
      const manager = window.editorManager;
      if (manager && manager.editor && manager.editor.state && manager.editor.state.doc) {
        return manager.editor.state.doc.toString();
      }
    } catch (_) {
    }
    try {
      const fs = window.acode && acode.require("fs");
      if (fs && typeof fs.readFile === "function") {
        const file = window.editorManager && window.editorManager.activeFile;
        if (file && file.path) return await fs.readFile(file.path);
      }
    } catch (_) {
    }
    return "";
  }

  cursorLine(file) {
    try {
      const view = window.editorManager && window.editorManager.editor;
      if (view && view.state && view.state.doc && view.state.selection) {
        const main = view.state.selection.main;
        if (main) return main.head.line + 1;
      }
    } catch (_) {
    }
    return 1;
  }

  languageOf(path) {
    const ext = String(path).split(".").pop().toLowerCase();
    const map = { py: "python", js: "javascript", ts: "typescript", jsx: "javascriptreact", tsx: "typescriptreact", rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp", java: "java", kt: "kotlin", rb: "ruby", php: "php", md: "markdown" };
    return map[ext] || "plaintext";
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 1500);
  }

  async poll() {
    try {
      const res = await this.fetch(this.baseUrl + "/api/v1/ide/action", { headers: this.authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const action = data && data.action;
      if (!action || !action.type) return;
      if (action.type === "open") {
        await this.openFile(action.path, action.line || 1, action.character || 0);
      } else if (action.type === "apply") {
        await this.confirmApply(action.path, action.content);
      }
    } catch (_) {
    }
  }

  async openFile(path, line, character) {
    try {
      const manager = window.editorManager;
      if (manager) {
        const existing = typeof manager.getFile === "function" ? manager.getFile(path, "path") : null;
        if (existing) {
          if (typeof existing.makeActive === "function") existing.makeActive();
          return;
        }
        if (typeof manager.switchFile === "function") {
          await manager.switchFile(path);
          return;
        }
      }
      const EditorFile = window.acode && acode.require("editorFile");
      if (EditorFile) {
        const file = new EditorFile(path, { text: "", render: true });
        if (manager && typeof manager.addFile === "function") manager.addFile(file);
      }
    } catch (_) {
    }
    if (this.page && this.page.notify) this.page.notify("Open " + path, "info");
  }

  async confirmApply(path, content) {
    const current = await this.readFileByPath(path);
    if (content === undefined || content === null) return;
    const confirmed = await this.showDiff(path, current || "", content);
    if (!confirmed) return;
    try {
      const manager = window.editorManager;
      if (manager && manager.editor && manager.editor.state && manager.editor.state.doc) {
        const view = manager.editor;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        const file = manager.activeFile;
        if (file && typeof file.save === "function") await file.save();
        this.pushContext(true);
        if (this.page && this.page.notify) this.page.notify("Applied to " + path, "success");
        return;
      }
    } catch (_) {
    }
    try {
      const fs = window.acode && acode.require("fs");
      if (fs && typeof fs.writeFile === "function") {
        await fs.writeFile(path, content);
        this.pushContext(true);
        if (this.page && this.page.notify) this.page.notify("Applied to " + path, "success");
        return;
      }
    } catch (_) {
    }
    if (this.page && this.page.notify) this.page.notify("Could not write " + path, "error");
  }

  async readFileByPath(path) {
    try {
      const fs = window.acode && acode.require("fs");
      if (fs && typeof fs.readFile === "function") return await fs.readFile(path);
    } catch (_) {
    }
    return "";
  }

  async showDiff(path, before, after) {
    if (window.acode && acode.require("dialog") && typeof acode.require("dialog").confirm === "function") {
      return await acode.require("dialog").confirm("Apply changes to " + path + "?", "OpenCode IDE", "Apply", "Cancel");
    }
    return window.confirm("Apply changes to " + path + "?");
  }

  destroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.edgeHandle && typeof this.edgeHandle.remove === "function") this.edgeHandle.remove();
    this.edgeHandle = null;
  }
}

if (window.acode) {
  const instance = new OpenCodeIdePlugin();
  acode.setPluginInit(PLUGIN_ID, async (baseUrl, page) => instance.init(baseUrl, page));
  acode.setPluginUnmount(PLUGIN_ID, () => instance.destroy());
}
