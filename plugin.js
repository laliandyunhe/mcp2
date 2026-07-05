// ============================================================
// 插件:AI MCP 工具调用桥接器(通用版 · 方案B)
// 功能:监控聊天消息,解析 AI 输出的工具调用标记,
//      转发给本地/远程 MCP Server 执行,再把结果写回对话
// ============================================================
(function () {
  'use strict';

  // ============================================================
  // 🔧 基础配置 —— 按你实际的 MCP 服务地址修改
  // ============================================================
  const DEFAULT_CONFIG = {
    // TODO: 改成你 mcp 页面对应服务的实际地址
    endpoint: 'http://127.0.0.1:5000/mcp',
    // TODO: 如果服务需要鉴权,填 token;不需要留空
    authToken: '',
    // 工具标记的正则,格式: [tool:工具名:{"参数":"值"}]
    tagPattern: /\[tool\s*:\s*([a-zA-Z0-9_]+)\s*:\s*(\{[\s\S]*?\})\]/g
  };

  // ============================================================
  // 🌍 全局状态(后台常驻)
  // ============================================================
  const GLOBAL_STATE = {
    roche: null,
    config: { ...DEFAULT_CONFIG },
    toolsCache: null, // MCP tools/list 缓存 [{name, description, inputSchema}, ...]
    currentConvId: '',
    isMonitoring: false,
    monitorInterval: null,
    lastProcessedTs: 0,
    onStatusChange: null,
    onLogChange: null,
    logLines: []
  };

  function log(text) {
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    GLOBAL_STATE.logLines.unshift(line);
    GLOBAL_STATE.logLines = GLOBAL_STATE.logLines.slice(0, 30);
    if (GLOBAL_STATE.onLogChange) GLOBAL_STATE.onLogChange(GLOBAL_STATE.logLines.join('\n'));
  }

  function updateStatus(text, isError) {
    if (GLOBAL_STATE.onStatusChange) GLOBAL_STATE.onStatusChange(text, isError);
  }

  // ============================================================
  // 📡 MCP JSON-RPC 客户端(Streamable HTTP 传输)
  // ============================================================
  class MCPClient {
    constructor(endpoint, authToken) {
      this.endpoint = endpoint;
      this.authToken = authToken;
      this._id = 0;
    }

    async _call(method, params) {
      const headers = { 'Content-Type': 'application/json' };
      if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this._id,
          method,
          params: params || {}
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.result;
    }

    async listTools() {
      const result = await this._call('tools/list', {});
      return (result && result.tools) || [];
    }

    async callTool(name, args) {
      const result = await this._call('tools/call', { name, arguments: args || {} });
      return result;
    }
  }

  let mcpClient = null;
  function getClient() {
    if (!mcpClient || mcpClient.endpoint !== GLOBAL_STATE.config.endpoint) {
      mcpClient = new MCPClient(GLOBAL_STATE.config.endpoint, GLOBAL_STATE.config.authToken);
    }
    return mcpClient;
  }

  // ============================================================
  // 🔍 拉取工具列表 + 生成系统提示词
  // ============================================================
  async function refreshTools() {
    const client = getClient();
    const tools = await client.listTools();
    GLOBAL_STATE.toolsCache = tools;
    await GLOBAL_STATE.roche.storage.set('mcpToolsCache', tools);
    return tools;
  }

  function buildSystemPrompt(tools) {
    const lines = [];
    lines.push('【工具调用能力】');
    lines.push('你可以使用下列工具获取真实信息或执行操作。需要用工具时,在回复中插入标记:');
    lines.push('[tool:工具名:{"参数名":"参数值"}]');
    lines.push('标记会被程序自动执行,不会展示给用户,执行结果会在你下一轮回复前提供给你。');
    lines.push('可用工具:');
    for (const t of tools) {
      const schema = t.inputSchema && t.inputSchema.properties
        ? Object.keys(t.inputSchema.properties).join(', ')
        : '无参数或参数见描述';
      lines.push(`- ${t.name}: ${t.description || ''}（参数: ${schema}）`);
    }
    lines.push('');
    lines.push('规则:');
    lines.push('1. 只在确实需要该信息/操作时才调用,不要每次回复都调用');
    lines.push('2. 一次回复里可以包含多个工具标记');
    lines.push('3. 标记单独存在即可,不需要额外解释你在调用工具');
    return lines.join('\n');
  }

  // ============================================================
  // 📝 解析 + 执行工具调用
  // ============================================================
  function parseToolCalls(text) {
    if (!text) return [];
    const calls = [];
    const re = new RegExp(GLOBAL_STATE.config.tagPattern);
    let m;
    while ((m = re.exec(text)) !== null) {
      let args = {};
      try {
        args = JSON.parse(m[2]);
      } catch (e) {
        log(`⚠️ 参数解析失败: ${m[0]}`);
        continue;
      }
      calls.push({ name: m[1], args, raw: m[0] });
    }
    return calls;
  }

  async function executeToolCalls(calls) {
    const client = getClient();
    const results = [];
    for (const call of calls) {
      try {
        const result = await client.callTool(call.name, call.args);
        log(`✅ ${call.name}(${JSON.stringify(call.args)}) -> ${JSON.stringify(result).slice(0, 100)}`);
        results.push({ name: call.name, args: call.args, ok: true, result });
      } catch (e) {
        log(`❌ ${call.name} 调用失败: ${e.message}`);
        results.push({ name: call.name, args: call.args, ok: false, error: e.message });
      }
    }
    return results;
  }

  // ============================================================
  // ✍️ 把工具结果写回对话,让 AI 下一轮能看到
  // TODO: 这里需要根据 roche 插件 API 的实际方法调整
  // ============================================================
  async function injectToolResults(results) {
    if (!results.length) return;

    const summary = results
      .map((r) => (r.ok ? `[${r.name}] 结果: ${JSON.stringify(r.result)}` : `[${r.name}] 失败: ${r.error}`))
      .join('\n');

    const roche = GLOBAL_STATE.roche;

    // 尝试几种常见的插入方式,按你实际 API 保留一个、删掉其他
    if (roche.conversation && typeof roche.conversation.sendSystemMessage === 'function') {
      await roche.conversation.sendSystemMessage(GLOBAL_STATE.currentConvId, {
        role: 'system',
        content: `[工具执行结果]\n${summary}`
      });
      return;
    }

    if (roche.conversation && typeof roche.conversation.insertNote === 'function') {
      await roche.conversation.insertNote(GLOBAL_STATE.currentConvId, summary);
      return;
    }

    // 兜底方案:如果 MCP 工具里本身就有 save_memory,直接用它把结果存进记忆库
    // 前提是这条记忆会被自动带入下一轮的上下文
    try {
      const client = getClient();
      await client.callTool('save_memory', {
        key: `tool_result_${Date.now()}`,
        content: summary
      });
      log('ℹ️ 未找到对话插入接口,已改用 save_memory 兜底写入记忆库');
    } catch (e) {
      log('⚠️ 没有可用的写回方式,请检查 roche API 或手动补充 injectToolResults()');
    }
  }

  // ============================================================
  // 👀 消息监控
  // ============================================================
  async function checkMessages() {
    const roche = GLOBAL_STATE.roche;
    if (!GLOBAL_STATE.currentConvId || !roche) return;

    try {
      const msgs = await roche.memory.getShortTerm({
        conversationId: GLOBAL_STATE.currentConvId,
        limit: 10
      });
      if (!msgs || !msgs.length) return;

      for (const msg of msgs) {
        const ts = msg.timestamp || msg.createdAt || 0;
        if (ts <= GLOBAL_STATE.lastProcessedTs) continue;
        if (msg.role !== 'assistant' && msg.role !== 'ai') continue; // 只处理 AI 消息

        const calls = parseToolCalls(msg.content || msg.text || '');
        if (calls.length) {
          log(`📩 检测到 ${calls.length} 个工具调用请求`);
          const results = await executeToolCalls(calls);
          await injectToolResults(results);
        }
        GLOBAL_STATE.lastProcessedTs = Math.max(GLOBAL_STATE.lastProcessedTs, ts);
      }
    } catch (e) {
      log(`⚠️ 监控异常: ${e.message}`);
    }
  }

  function startMonitor() {
    stopMonitor();
    GLOBAL_STATE.isMonitoring = true;
    GLOBAL_STATE.monitorInterval = setInterval(checkMessages, 3000);
    updateStatus('✅ 监控已启动');
  }

  function stopMonitor() {
    if (GLOBAL_STATE.monitorInterval) clearInterval(GLOBAL_STATE.monitorInterval);
    GLOBAL_STATE.monitorInterval = null;
    GLOBAL_STATE.isMonitoring = false;
  }

  // ============================================================
  // 🖼️ 插件页面
  // ============================================================
  const pluginApp = {
    async mount(container, ctx) {
      const roche = ctx.roche;
      GLOBAL_STATE.roche = roche;

      const savedConfig = await roche.storage.get('mcpConfig');
      if (savedConfig) GLOBAL_STATE.config = { ...DEFAULT_CONFIG, ...savedConfig };

      const savedConvId = await roche.storage.get('mcpConversationId');
      if (savedConvId) GLOBAL_STATE.currentConvId = savedConvId;

      container.innerHTML = `
        <div style="padding:12px; font-family:sans-serif;">
          <h3 style="margin:0 0 12px 0;">🔧 MCP 工具调用桥接</h3>

          <fieldset style="border:1px solid #ccc; border-radius:6px; padding:8px; margin-bottom:10px;">
            <legend>MCP 服务配置</legend>
            <input id="mcp-endpoint" type="text" placeholder="http://127.0.0.1:端口/mcp"
              value="${GLOBAL_STATE.config.endpoint}" style="width:100%; padding:4px; margin-bottom:4px;" />
            <input id="mcp-token" type="text" placeholder="鉴权 token(可留空)"
              value="${GLOBAL_STATE.config.authToken}" style="width:100%; padding:4px;" />
            <button id="mcp-save-config" style="margin-top:6px; width:100%; background:#2196F3; color:white; border:none; border-radius:4px; padding:6px;">保存配置</button>
          </fieldset>

          <fieldset style="border:1px solid #ccc; border-radius:6px; padding:8px; margin-bottom:10px;">
            <legend>工具列表</legend>
            <button id="mcp-refresh-tools" style="width:100%; background:#4CAF50; color:white; border:none; border-radius:4px; padding:6px;">拉取工具列表</button>
            <div id="mcp-tools-list" style="margin-top:6px; font-size:12px; max-height:150px; overflow:auto;"></div>
            <button id="mcp-copy-prompt" style="margin-top:6px; width:100%; background:#FF9800; color:white; border:none; border-radius:4px; padding:6px;">生成并复制系统提示词</button>
          </fieldset>

          <fieldset style="border:1px solid #ccc; border-radius:6px; padding:8px; margin-bottom:10px;">
            <legend>监控设置</legend>
            <select id="mcp-conv-select" style="width:100%; padding:4px; margin-bottom:6px;">
              <option value="">-- 选择要监控的会话 --</option>
            </select>
            <label style="display:flex; align-items:center; gap:4px;">
              <input type="checkbox" id="mcp-auto-monitor" ${GLOBAL_STATE.isMonitoring ? 'checked' : ''} />
              后台自动监控
            </label>
            <div id="mcp-status" style="padding:4px 8px; border-radius:4px; background:#eee; font-size:12px; margin-top:6px;">
              ${GLOBAL_STATE.isMonitoring ? '✅ 监控中' : '未监控'}
            </div>
          </fieldset>

          <fieldset style="border:1px solid #ccc; border-radius:6px; padding:8px; margin-bottom:10px;">
            <legend>手动测试</legend>
            <input id="mcp-test-name" type="text" placeholder="工具名,如 get_weather" style="width:100%; padding:4px; margin-bottom:4px;" />
            <input id="mcp-test-args" type="text" placeholder='参数JSON,如 {}' style="width:100%; padding:4px; margin-bottom:4px;" />
            <button id="mcp-test-call" style="width:100%; background:#4CAF50; color:white; border:none; border-radius:4px; padding:6px;">调用</button>
          </fieldset>

          <fieldset style="border:1px solid #ccc; border-radius:6px; padding:8px;">
            <legend>日志</legend>
            <pre id="mcp-log" style="font-size:11px; white-space:pre-wrap; max-height:150px; overflow:auto; margin:0;"></pre>
          </fieldset>
        </div>
      `;

      const $ = (s) => container.querySelector(s);
      const statusDiv = $('#mcp-status');
      const logPre = $('#mcp-log');
      const toolsListDiv = $('#mcp-tools-list');
      const convSelect = $('#mcp-conv-select');

      GLOBAL_STATE.onStatusChange = (text, isError) => {
        statusDiv.textContent = text;
        statusDiv.style.background = isError ? '#f8d7da' : '#d4edda';
      };
      GLOBAL_STATE.onLogChange = (text) => { logPre.textContent = text; };

      async function populateConvs(selectId) {
        try {
          const convs = await roche.conversation.list();
          convSelect.innerHTML = '<option value="">-- 选择要监控的会话 --</option>';
          for (const c of convs) {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name || c.handle || c.id;
            convSelect.appendChild(opt);
            if (c.id === selectId) opt.selected = true;
          }
        } catch (e) {}
      }
      populateConvs(GLOBAL_STATE.currentConvId);

      function renderTools(tools) {
        toolsListDiv.innerHTML = tools
          .map((t) => `<div>• <b>${t.name}</b> — ${t.description || ''}</div>`)
          .join('');
      }
      if (GLOBAL_STATE.toolsCache) renderTools(GLOBAL_STATE.toolsCache);

      $('#mcp-save-config').onclick = async () => {
        GLOBAL_STATE.config.endpoint = $('#mcp-endpoint').value.trim();
        GLOBAL_STATE.config.authToken = $('#mcp-token').value.trim();
        await roche.storage.set('mcpConfig', GLOBAL_STATE.config);
        roche.ui.toast('配置已保存');
      };

      $('#mcp-refresh-tools').onclick = async () => {
        try {
          const tools = await refreshTools();
          renderTools(tools);
          roche.ui.toast(`已拉取 ${tools.length} 个工具`);
        } catch (e) {
          roche.ui.toast(`拉取失败: ${e.message}`);
        }
      };

      $('#mcp-copy-prompt').onclick = async () => {
        const tools = GLOBAL_STATE.toolsCache || (await refreshTools());
        const prompt = buildSystemPrompt(tools);
        await navigator.clipboard.writeText(prompt);
        roche.ui.toast('系统提示词已复制,粘贴到角色人设末尾即可');
      };

      convSelect.onchange = async () => {
        GLOBAL_STATE.currentConvId = convSelect.value;
        await roche.storage.set('mcpConversationId', GLOBAL_STATE.currentConvId);
      };

      $('#mcp-auto-monitor').onchange = (e) => {
        if (e.target.checked) {
          if (!GLOBAL_STATE.currentConvId) {
            roche.ui.toast('请先选择要监控的会话');
            e.target.checked = false;
            return;
          }
          startMonitor();
        } else {
          stopMonitor();
          updateStatus('未监控');
        }
      };

      $('#mcp-test-call').onclick = async () => {
        const name = $('#mcp-test-name').value.trim();
        let args = {};
        try {
          args = JSON.parse($('#mcp-test-args').value || '{}');
        } catch (e) {
          roche.ui.toast('参数不是合法 JSON');
          return;
        }
        try {
          const client = getClient();
          const result = await client.callTool(name, args);
          log(`手动调用 ${name} -> ${JSON.stringify(result)}`);
        } catch (e) {
          log(`手动调用失败: ${e.message}`);
        }
      };
    },

    async unmount(container) {
      GLOBAL_STATE.onStatusChange = null;
      GLOBAL_STATE.onLogChange = null;
      container.replaceChildren();
    }
  };

  // ============================================================
  // 📦 注册插件
  // ============================================================
  window.RochePlugin.register({
    id: 'mcp-tool-bridge',
    name: 'MCP 工具调用桥接',
    version: '1.0.0',
    description: '让 AI 在聊天中调用 MCP 工具(方案B:标记解析 + 轮询)',
    author: 'Roche 社区',
    apps: [pluginApp]
  });

  window.__mcpBridge = {
    state: GLOBAL_STATE,
    getClient,
    refreshTools,
    buildSystemPrompt,
    parseToolCalls,
    executeToolCalls,
    startMonitor,
    stopMonitor
  };
})();
