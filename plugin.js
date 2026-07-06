/**
 * MCP 工具桥接插件 (终极原生破解版)
 *
 * 核心技术：
 * 1. 纯原生自启：不依赖 Roche API，使用 LocalStorage 保存配置，JS 一加载立刻启动后台轮询。
 * 2. 原生 IndexedDB 读取：绕过官方接口限制，直接读取底层数据库。
 * 3. 强行 DOM 注入：提取了 Roche 官方的 CSS 类名，用原生 JS 直接在屏幕上“画”出一个完美的官方样式聊天气泡。
 */
(function () {
  "use strict";

  // ============================================================
  // 🌍 1. 原生存储与全局状态 (彻底脱离 Roche API 束缚)
  // ============================================================
  const STORAGE_KEY = "mcp_bridge_native_config";
  const GLOBAL_STATE = {
    servers: [],
    monitorConvIds: [],
    lastProcessedTs: {},
    isMonitoring: false,
    monitorInterval: null,
    sessionRefs: {},
    logLines: [],
    onLogChange: null,
    onMonitorStatusChange: null,
  };

  function log(text) {
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    GLOBAL_STATE.logLines.unshift(line);
    GLOBAL_STATE.logLines = GLOBAL_STATE.logLines.slice(0, 50);
    if (GLOBAL_STATE.onLogChange) GLOBAL_STATE.onLogChange(GLOBAL_STATE.logLines.join("\n"));
    console.log("[MCP Bridge]", text);
  }

  function makeId() { return Math.random().toString(36).slice(2, 10); }

  // 加载原生配置 (无需等待插件面板打开)
  function loadConfigNative() {
    try {
      const str = localStorage.getItem(STORAGE_KEY);
      if (str) {
        const config = JSON.parse(str);
        GLOBAL_STATE.servers = config.servers || [];
        GLOBAL_STATE.monitorConvIds = config.monitorConvIds || [];
        GLOBAL_STATE.lastProcessedTs = config.lastProcessedTs || {};
        GLOBAL_STATE.isMonitoring = config.enabled || false;
      }
    } catch (e) { log("读取原生配置失败"); }
  }

  // 保存原生配置
  function saveConfigNative() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        servers: GLOBAL_STATE.servers,
        monitorConvIds: GLOBAL_STATE.monitorConvIds,
        lastProcessedTs: GLOBAL_STATE.lastProcessedTs,
        enabled: GLOBAL_STATE.isMonitoring
      }));
    } catch (e) { log("保存原生配置失败"); }
  }

  // ============================================================
  // 📡 2. MCP JSON-RPC 核心逻辑
  // ============================================================
  async function rawRpc(server, method, params, sessionRef) {
    const headers = { "Content-Type": "application/json" };
    (server.headers || []).forEach((h) => { if (h.key) headers[h.key] = h.value || ""; });
    if (sessionRef.id) headers["Mcp-Session-Id"] = sessionRef.id;

    const resp = await fetch(server.url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} }),
    });
    const sid = resp.headers.get("Mcp-Session-Id");
    if (sid) sessionRef.id = sid;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  async function ensureSession(server) {
    if (!GLOBAL_STATE.sessionRefs[server.id]) GLOBAL_STATE.sessionRefs[server.id] = { id: null };
    const sessionRef = GLOBAL_STATE.sessionRefs[server.id];
    if (!sessionRef.initialized) {
      await rawRpc(server, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "roche-mcp", version: "1.0" } }, sessionRef);
      sessionRef.initialized = true;
    }
    return sessionRef;
  }

  async function testAndListTools(server) {
    if (server.transport === "sse") throw new Error("暂时只支持直接测试 Streamable HTTP");
    const sessionRef = { id: null };
    const startedAt = Date.now();
    await rawRpc(server, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "roche-mcp", version: "1.0" } }, sessionRef);
    const list = await rawRpc(server, "tools/list", {}, sessionRef);
    const latency = Date.now() - startedAt;
    const tools = (list.tools || []).map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || {} }));
    return { tools, latency };
  }

  async function callServerTool(server, toolName, args) {
    const sessionRef = await ensureSession(server);
    try {
      return await rawRpc(server, "tools/call", { name: toolName, arguments: args || {} }, sessionRef);
    } catch (e) {
      sessionRef.initialized = false; sessionRef.id = null;
      const retryRef = await ensureSession(server);
      return await rawRpc(server, "tools/call", { name: toolName, arguments: args || {} }, retryRef);
    }
  }

  function isToolEnabled(server, toolName) {
    const f = server.toolsEnabled;
    return f === null || f === undefined || f.includes(toolName);
  }

  function findServerForTool(servers, toolName) {
    for (const s of servers) {
      if (!s.enabled || s.transport === "sse") continue;
      const tool = (s.cachedTools || []).find((t) => t.name === toolName);
      if (tool && isToolEnabled(s, toolName)) return s;
    }
    return null;
  }

  // ============================================================
  // ⚡ 3. 核心黑科技：DOM 精准注入 + 原生 IndexedDB 读写
  // ============================================================

  // 纯原生读取 IndexedDB
  function openNativeDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("Roche_db");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 高效倒序读取最新消息，不依赖 Roche API
  function getRecentMessagesNative(db, convId, limit = 10) {
    return new Promise((resolve) => {
      const tx = db.transaction("messages", "readonly");
      const store = tx.objectStore("messages");
      const msgs = [];
      const req = store.openCursor(null, "prev"); // 倒序游标，速度极快
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && msgs.length < limit) {
          if (cursor.value.conversationId === convId) msgs.push(cursor.value);
          cursor.continue();
        } else {
          resolve(msgs.reverse());
        }
      };
    });
  }

  function writeMessageNative(db, msg) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("messages", "readwrite");
      const req = tx.objectStore("messages").add(msg);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // 逆向提取了 Roche 的原生 Tailwind CSS 类名，完美伪装气泡
  function forceInjectNativeUI(toolName, result) {
    try {
      // 寻找原生聊天容器
      const chatArea = document.querySelector('.chat-scroll-area');
      if (!chatArea) return;

      const row = document.createElement("div");
      row.className = "flex flex-col w-full chat-message-row";

      // 防止内容过长
      const resultStr = JSON.stringify(result).length > 800 
        ? JSON.stringify(result).slice(0, 800) + '\n\n... (内容过长已折叠)' 
        : JSON.stringify(result);

      // 完美一比一复刻 Roche 官方接收消息气泡 DOM 结构
      row.innerHTML = `
        <div class="chat-message flex items-start gap-2 mb-2 w-full transition-all duration-300 select-none chat-message--received flex-row" style="column-gap: 8px; margin-bottom: 8px;">
          <div class="chat-message-avatar-placeholder shrink-0 pointer-events-none chat-message-avatar-placeholder--received" style="width: 40px; height: 40px;"></div>
          <div class="chat-message-content flex flex-col min-w-0 text-[15px] chat-message-content--received items-start" style="max-width: 85%;">
            <div class="chat-message-sender-name mb-1 flex max-w-full items-center gap-1.5 text-[10px] font-bold text-zinc-500 justify-start">
              <span class="chat-header-online text-[9px] text-zinc-400 uppercase tracking-[0.15em] font-medium">MCP TOOL</span>
            </div>
            <div class="chat-bubble chat-bubble--text px-3 py-[7px] shadow-sm min-h-[34px] w-fit max-w-full relative group/tts chat-bubble--received bubble-received bg-bubble-received text-black cursor-pointer" style="padding: 12px 16px; border-radius: 10px;">
              <div class="chat-message-body flex items-center gap-1.5 chat-message-body--received flex-row">
                <p class="whitespace-pre-wrap break-words min-w-0" style="word-break: break-word;">
                  <strong>🔧 工具 [${toolName}] 执行完毕</strong><br/>
                  <span style="font-size: 13px; color: #555;">${resultStr}</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      `;

      chatArea.appendChild(row);
      // 平滑滚动到底部
      setTimeout(() => { chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: 'smooth' }); }, 100);
    } catch (e) {
      log("注入气泡失败：" + e.message);
    }
  }

  // ============================================================
  // 🤖 4. AI 标记解析与监控循环
  // ============================================================
  const TAG_PATTERN = /\[tool\s*:\s*([a-zA-Z0-9_]+)\s*:\s*(\{[\s\S]*?\})\]/g;
  function parseToolCalls(text) {
    if (!text) return [];
    const calls = []; let m;
    const re = new RegExp(TAG_PATTERN);
    while ((m = re.exec(text)) !== null) {
      try { calls.push({ name: m[1], args: JSON.parse(m[2]), raw: m[0] }); } catch (e) {}
    }
    return calls;
  }

  function buildSystemPrompt(servers) {
    const lines = ["【工具调用能力】", '你可以使用下列工具获取信息或执行操作。需要用工具时,在回复中插入标记:', '[tool:工具名:{"参数名":"参数值"}]', "标记会被程序自动执行。结果可能在下一轮才提供给你。", "可用工具:"];
    for (const s of servers) {
      if (!s.enabled || s.transport === "sse") continue;
      for (const t of s.cachedTools || []) {
        if (!isToolEnabled(s, t.name)) continue;
        const props = t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [];
        lines.push(`- ${t.name}: ${t.description || ""}${props.length ? `（参数: ${props.join(", ")}）` : "（无参数）"}`);
      }
    }
    return lines.join("\n");
  }

  async function checkNativeDbLoop() {
    if (!GLOBAL_STATE.isMonitoring || GLOBAL_STATE.monitorConvIds.length === 0) return;
    try {
      const db = await openNativeDb();
      for (const convId of GLOBAL_STATE.monitorConvIds) {
        const msgs = await getRecentMessagesNative(db, convId, 10);
        const lastTs = GLOBAL_STATE.lastProcessedTs[convId] || 0;
        let maxTs = lastTs;

        for (const msg of msgs) {
          const ts = msg.timestamp || 0;
          if (ts <= lastTs) continue;
          maxTs = Math.max(maxTs, ts);

          if (msg.isMe === true) continue; // 忽略用户自己发的消息

          const text = msg.text || msg.content || "";
          const calls = parseToolCalls(text);
          if (!calls.length) continue;

          for (const call of calls) {
            const server = findServerForTool(GLOBAL_STATE.servers, call.name);
            if (!server) continue;
            try {
              log(`⚙️ 正在执行工具: ${call.name}`);
              const result = await callServerTool(server, call.name, call.args);
              
              // 1. 写入数据库
              const now = Date.now();
              await writeMessageNative(db, {
                id: now + Math.floor(Math.random() * 1000),
                isMe: false,
                text: `🔧 [${call.name}] ${JSON.stringify(result)}`,
                senderId: msg.senderId || "mcp-system",
                timestamp: now,
                senderName: "MCP 工具",
                conversationId: convId,
              });
              
              // 2. 强行画面注入
              forceInjectNativeUI(call.name, result);
              log(`✅ ${call.name} 注入成功`);
            } catch (e) {
              log(`❌ 工具失败: ${e.message}`);
            }
          }
        }
        if (maxTs > lastTs) {
          GLOBAL_STATE.lastProcessedTs[convId] = maxTs;
          saveConfigNative();
        }
      }
      db.close();
    } catch (e) {
      log("轮询数据库异常: " + e.message);
    }
  }

  function startMonitor() {
    if (GLOBAL_STATE.monitorInterval) clearInterval(GLOBAL_STATE.monitorInterval);
    GLOBAL_STATE.isMonitoring = true;
    saveConfigNative();
    GLOBAL_STATE.monitorInterval = setInterval(checkNativeDbLoop, 4000);
    if (GLOBAL_STATE.onMonitorStatusChange) GLOBAL_STATE.onMonitorStatusChange(true);
    log("🚀 MCP 后台原生监控已启动");
  }

  function stopMonitor() {
    if (GLOBAL_STATE.monitorInterval) clearInterval(GLOBAL_STATE.monitorInterval);
    GLOBAL_STATE.monitorInterval = null;
    GLOBAL_STATE.isMonitoring = false;
    saveConfigNative();
    if (GLOBAL_STATE.onMonitorStatusChange) GLOBAL_STATE.onMonitorStatusChange(false);
    log("⏸️ 监控已停止");
  }

  // ============================================================
  // 🚀 5. 立即执行自启动逻辑 (不依赖插件面板打开)
  // ============================================================
  loadConfigNative();
  if (GLOBAL_STATE.isMonitoring && GLOBAL_STATE.monitorConvIds.length > 0) {
    startMonitor(); // 文件加载瞬间，立刻开始静默轮询！
  }

  // ============================================================
  // 🖼️ 6. 插件 UI 设置面板
  // ============================================================
  window.RochePlugin.register({
    id: "mcp-tool-bridge",
    name: "MCP 工具桥接",
    version: "1.2.0",
    apps: [
      {
        id: "mcp-tool-bridge-home",
        name: "MCP 工具面板",
        icon: "settings",
        
        async mount(container, roche) {
          // 重新读取一次确保同步
          loadConfigNative();
          
          const state = { view: "list", editing: null, editTab: "basic", testStatus: "idle", testMessage: "", conversations: [] };

          const style = document.createElement("style");
          style.textContent = `
            .rmtb-root { font-family: sans-serif; height: 100%; overflow-y: auto; background: #111214; color: #eee; padding: 12px; box-sizing: border-box; }
            .rmtb-root * { box-sizing: border-box; }
            .rmtb-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 8px; }
            .rmtb-title { font-size: 17px; font-weight: 600; flex: 1; }
            .rmtb-back, .rmtb-add, .rmtb-nav-btn { background: #2a2b2f; color: #eee; border: none; border-radius: 8px; padding: 6px 12px; font-size: 13px; }
            .rmtb-add { background: #3b6ef0; }
            .rmtb-nav-btn.active { background: #3b6ef0; }
            .rmtb-empty { color: #666; font-size: 13px; text-align: center; padding: 40px 0; }
            .rmtb-server-item { background: #1b1c1f; border-radius: 12px; padding: 12px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .rmtb-server-info { flex: 1; min-width: 0; }
            .rmtb-server-name { font-size: 14px; font-weight: 600; }
            .rmtb-server-url { font-size: 12px; color: #888; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .rmtb-server-meta { font-size: 11px; color: #666; margin-top: 2px; }
            .rmtb-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:4px; }
            .rmtb-dot.on { background:#4ade80; } .rmtb-dot.off { background:#666; }
            .rmtb-tabs { display: flex; border-bottom: 1px solid #2a2b2f; margin-bottom: 16px; }
            .rmtb-tab { flex: 1; text-align: center; padding: 10px 0; font-size: 14px; color: #999; }
            .rmtb-tab.active { color: #6ea8fe; border-bottom: 2px solid #3b6ef0; font-weight: 600; }
            .rmtb-field { margin-bottom: 16px; }
            .rmtb-label { font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px; }
            .rmtb-hint { font-size: 12px; color: #888; margin-bottom: 8px; display: block; }
            .rmtb-input { width: 100%; background: #1b1c1f; color: #eee; border: 1px solid #333; border-radius: 10px; padding: 12px; font-size: 14px; }
            .rmtb-switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; display:inline-block; }
            .rmtb-switch input { opacity: 0; width: 0; height: 0; }
            .rmtb-slider { position: absolute; cursor: pointer; inset: 0; background: #444; border-radius: 24px; transition: 0.15s; }
            .rmtb-slider:before { content: ""; position: absolute; height: 18px; width: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.15s; }
            .rmtb-switch input:checked + .rmtb-slider { background: #3b6ef0; }
            .rmtb-switch input:checked + .rmtb-slider:before { transform: translateX(20px); }
            .rmtb-segment { display: flex; border: 1px solid #333; border-radius: 10px; overflow: hidden; }
            .rmtb-segment-btn { flex: 1; text-align: center; padding: 10px; font-size: 13px; background: #1b1c1f; color: #ccc; }
            .rmtb-segment-btn.active { background: #2a3a6e; color: #9ec2ff; }
            .rmtb-header-row-btn { width: 100%; background: #2a2b2f; color: #eee; border: none; border-radius: 10px; padding: 12px; font-size: 14px; text-align: center; }
            .rmtb-header-row { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
            .rmtb-header-row input { flex: 1; }
            .rmtb-header-remove { background: #7a2a2a; color: #fff; border: none; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
            .rmtb-btn-row { display: flex; gap: 8px; margin-top: 20px; }
            .rmtb-btn { flex: 1; border: none; border-radius: 10px; padding: 12px; font-size: 14px; }
            .rmtb-btn.primary { background: #3b6ef0; color: #fff; }
            .rmtb-btn.secondary { background: #2a2b2f; color: #eee; }
            .rmtb-btn.danger { background: #7a2a2a; color: #fff; }
            .rmtb-status { font-size: 13px; margin-top: 8px; line-height: 1.5; }
            .rmtb-status.success { color: #4ade80; }
            .rmtb-status.error { color: #f87171; }
            .rmtb-status.testing { color: #fbbf24; }
            .rmtb-tool-row { background: #1b1c1f; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .rmtb-tool-name { font-size: 13px; font-weight: 600; }
            .rmtb-tool-desc { font-size: 11px; color: #888; margin-top: 2px; }
            .rmtb-conv-row { background: #1b1c1f; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .rmtb-log { font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow: auto; background:#1b1c1f; border-radius:10px; padding:10px; margin:0; }
          `;
          container.appendChild(style);

          const root = document.createElement("div");
          root.className = "rmtb-root";
          container.appendChild(root);

          function escapeHtml(str) {
            return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          }

          function renderTopNav() {
            const nav = document.createElement("div"); nav.className = "rmtb-header";
            const title = document.createElement("div"); title.className = "rmtb-title"; title.textContent = "MCP桥接(真原生版)"; nav.appendChild(title);
            
            const serversBtn = document.createElement("button"); serversBtn.className = "rmtb-nav-btn" + (state.view === "list" || state.view === "edit" ? " active" : ""); serversBtn.textContent = "服务器"; serversBtn.onclick = () => { state.view = "list"; render(); }; nav.appendChild(serversBtn);
            
            const monitorBtn = document.createElement("button"); monitorBtn.className = "rmtb-nav-btn" + (state.view === "monitor" ? " active" : ""); monitorBtn.textContent = "监控"; monitorBtn.onclick = async () => { state.view = "monitor"; state.conversations = await roche.conversation.list(); render(); }; nav.appendChild(monitorBtn);
            
            const closeBtn = document.createElement("button"); closeBtn.className = "rmtb-back"; closeBtn.textContent = "返回"; closeBtn.onclick = () => roche.ui.closeApp(); nav.appendChild(closeBtn);
            root.appendChild(nav);
          }

          function renderList() {
            const addBtn = document.createElement("button"); addBtn.className = "rmtb-add"; addBtn.style.width = "100%"; addBtn.style.marginBottom = "12px"; addBtn.textContent = "+ 添加 MCP Server"; addBtn.onclick = () => openEdit(null); root.appendChild(addBtn);

            if (GLOBAL_STATE.servers.length === 0) {
              const empty = document.createElement("div"); empty.className = "rmtb-empty"; empty.textContent = '还没有添加 MCP Server'; root.appendChild(empty); return;
            }

            GLOBAL_STATE.servers.forEach((server) => {
              const item = document.createElement("div"); item.className = "rmtb-server-item";
              const info = document.createElement("div"); info.className = "rmtb-server-info";
              const toolCount = server.toolsEnabled === null || server.toolsEnabled === undefined ? `全部工具(${(server.cachedTools || []).length})` : `${server.toolsEnabled.length}/${(server.cachedTools || []).length} 启用`;
              info.innerHTML = `<div class="rmtb-server-name">${escapeHtml(server.name || "未命名")}</div><div class="rmtb-server-url">${escapeHtml(server.url)}</div><div class="rmtb-server-meta"><span class="rmtb-dot ${server.enabled ? "on" : "off"}"></span>${server.enabled ? "已启用" : "已禁用"} · ${toolCount}</div>`;
              info.onclick = () => openEdit(server); item.appendChild(info);

              const switchLabel = document.createElement("label"); switchLabel.className = "rmtb-switch";
              const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = server.enabled;
              checkbox.onchange = (e) => { server.enabled = e.target.checked; saveConfigNative(); render(); };
              const slider = document.createElement("span"); slider.className = "rmtb-slider"; switchLabel.appendChild(checkbox); switchLabel.appendChild(slider); item.appendChild(switchLabel);
              root.appendChild(item);
            });

            const promptBtn = document.createElement("button"); promptBtn.className = "rmtb-btn primary"; promptBtn.style.width = "100%"; promptBtn.style.marginTop = "12px"; promptBtn.textContent = "生成系统提示词";
            promptBtn.onclick = async () => {
              const prompt = buildSystemPrompt(GLOBAL_STATE.servers);
              try { await navigator.clipboard.writeText(prompt); roche.ui.toast("已复制"); } catch (e) { roche.ui.toast("复制失败"); }
            };
            root.appendChild(promptBtn);
          }

          function openEdit(server) {
            state.editing = server ? JSON.parse(JSON.stringify(server)) : emptyServer();
            if (!state.editing.cachedTools) state.editing.cachedTools = [];
            state.editTab = "basic"; state.testStatus = "idle"; state.testMessage = "";
            state.view = "edit"; render();
          }

          async function saveEditing() {
            if (!state.editing.name.trim() || !state.editing.url.trim()) return roche.ui.toast("名称和URL必填");
            const idx = GLOBAL_STATE.servers.findIndex((s) => s.id === state.editing.id);
            if (idx === -1) GLOBAL_STATE.servers.push(state.editing); else GLOBAL_STATE.servers[idx] = state.editing;
            saveConfigNative(); state.view = "list"; roche.ui.toast("已保存"); render();
          }

          function renderEdit() {
            root.innerHTML += `<div class="rmtb-title" style="margin-bottom:12px;">${state.editing.name ? escapeHtml(state.editing.name) : "新 MCP Server"}</div>`;
            const urlField = document.createElement("div"); urlField.className = "rmtb-field";
            urlField.innerHTML = `<span class="rmtb-label">名称</span><input class="rmtb-input" placeholder="名称" value="${state.editing.name}">`;
            urlField.querySelector("input").oninput = (e) => { state.editing.name = e.target.value; }; root.appendChild(urlField);
            
            const urlF2 = document.createElement("div"); urlF2.className = "rmtb-field";
            urlF2.innerHTML = `<span class="rmtb-label">URL</span><input class="rmtb-input" placeholder="http://127.0.0.1:port/mcp" value="${state.editing.url}">`;
            urlF2.querySelector("input").oninput = (e) => { state.editing.url = e.target.value; }; root.appendChild(urlF2);

            const testBtn = document.createElement("button"); testBtn.className = "rmtb-btn secondary"; testBtn.style.width="100%"; testBtn.textContent = "测试连接并拉取工具";
            testBtn.onclick = async () => {
              testBtn.textContent = "连接中...";
              try {
                const { tools } = await testAndListTools(state.editing);
                state.editing.cachedTools = tools; testBtn.textContent = `成功! 获取到 ${tools.length} 个工具`;
              } catch(e) { testBtn.textContent = "失败: " + e.message; }
            };
            root.appendChild(testBtn);

            const btnRow = document.createElement("div"); btnRow.className = "rmtb-btn-row";
            const backBtn = document.createElement("button"); backBtn.className = "rmtb-btn secondary"; backBtn.textContent = "返回"; backBtn.onclick = () => { state.view = "list"; render(); }; btnRow.appendChild(backBtn);
            const saveBtn = document.createElement("button"); saveBtn.className = "rmtb-btn primary"; saveBtn.textContent = "保存"; saveBtn.onclick = saveEditing; btnRow.appendChild(saveBtn);
            root.appendChild(btnRow);
          }

          function renderMonitor() {
            const statusDiv = document.createElement("div"); statusDiv.className = "rmtb-status " + (GLOBAL_STATE.isMonitoring ? "success" : "");
            statusDiv.textContent = GLOBAL_STATE.isMonitoring ? "✅ 监控运行中 (后台自动轮询)" : "未监控"; root.appendChild(statusDiv);

            const toggleBtn = document.createElement("button"); toggleBtn.className = "rmtb-btn " + (GLOBAL_STATE.isMonitoring ? "danger" : "primary"); toggleBtn.style.width = "100%"; toggleBtn.style.margin = "10px 0";
            toggleBtn.textContent = GLOBAL_STATE.isMonitoring ? "停止监控" : "启动监控";
            toggleBtn.onclick = () => {
              if (GLOBAL_STATE.isMonitoring) stopMonitor(); else startMonitor();
              render();
            };
            root.appendChild(toggleBtn);

            const listLabel = document.createElement("div"); listLabel.className = "rmtb-label"; listLabel.textContent = "选择要监控的会话"; root.appendChild(listLabel);
            state.conversations.forEach((c) => {
              const row = document.createElement("div"); row.className = "rmtb-conv-row";
              row.innerHTML = `<div>${escapeHtml(c.name || c.title || c.id)}</div>`;
              const switchLabel = document.createElement("label"); switchLabel.className = "rmtb-switch";
              const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = GLOBAL_STATE.monitorConvIds.includes(c.id);
              checkbox.onchange = (e) => {
                const set = new Set(GLOBAL_STATE.monitorConvIds);
                if (e.target.checked) set.add(c.id); else set.delete(c.id);
                GLOBAL_STATE.monitorConvIds = Array.from(set); saveConfigNative();
              };
              const slider = document.createElement("span"); slider.className = "rmtb-slider"; switchLabel.appendChild(checkbox); switchLabel.appendChild(slider); row.appendChild(switchLabel);
              root.appendChild(row);
            });

            const logLabel = document.createElement("div"); logLabel.className = "rmtb-label"; logLabel.style.marginTop="16px"; logLabel.textContent = "运行日志"; root.appendChild(logLabel);
            const logPre = document.createElement("pre"); logPre.className = "rmtb-log"; logPre.textContent = GLOBAL_STATE.logLines.join("\n"); root.appendChild(logPre);
            GLOBAL_STATE.onLogChange = (text) => { logPre.textContent = text; };
            GLOBAL_STATE.onMonitorStatusChange = () => render();
          }

          function render() {
            root.innerHTML = ""; renderTopNav();
            if (state.view === "list") renderList(); else if (state.view === "edit") renderEdit(); else renderMonitor();
          }
          render();
          container.__rmtbCleanup = () => style.remove();
        },

        async unmount(container) {
          GLOBAL_STATE.onLogChange = null;
          GLOBAL_STATE.onMonitorStatusChange = null;
          if (container.__rmtbCleanup) container.__rmtbCleanup();
          container.replaceChildren();
        },
      },
    ],
  });
})();