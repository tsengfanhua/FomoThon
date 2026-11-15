// MCP（Model Context Protocol）協定層：JSON-RPC 2.0 訊息處理、版本協商與連線生命週期。
// 與傳輸方式無關：stdio（src/mcp/stdio.js）與 Streamable HTTP（src/mcp/http.js）共用這一層。
// 不依賴官方 SDK（維持零相依）；互通性由 test/mcp-interop.test.js 以官方 SDK client 實測。
import {assertSupported, formatErrors, validate} from '../jsonschema.js';

/** 支援的協定版本（新到舊）。用戶端要求的版本若不在清單內，回覆最新版，由用戶端決定是否中斷。 */
export const SUPPORTED_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];

export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RESOURCE_NOT_FOUND: -32002,
});

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PRE_INIT_METHODS = new Set(['initialize', 'ping']);

export class McpError extends Error {
  /**
   * @param {number} code JSON-RPC 錯誤碼
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isValidId = id => typeof id === 'string' || Number.isInteger(id);

export const errorResponse = (id, code, message, data) => ({
  jsonrpc: '2.0', id: id ?? null, error: {code, message, ...(data === undefined ? {} : {data})},
});

/** 把 RFC 6570 第一級樣板（例如 fomothon://skills/{skillId}）轉成比對用的正規表示式。 */
function templateMatcher(uriTemplate) {
  const names = [];
  const source = uriTemplate.split(/(\{[A-Za-z]+\})/).map(part => {
    if (/^\{[A-Za-z]+\}$/.test(part)) {
      names.push(part.slice(1, -1));
      return '([^/?#]+)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  const re = new RegExp(`^${source}$`);
  return uri => {
    const m = re.exec(uri);
    if (!m) return null;
    try {
      return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
    } catch {
      return null; // 百分比編碼壞掉：視為找不到資源，而不是內部錯誤
    }
  };
}

const toolResult = (text, isError = false) => ({content: [{type: 'text', text}], ...(isError ? {isError: true} : {})});

function checkDefinitions(tools, prompts) {
  const names = new Set();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`工具名稱不符合 MCP 規範：${tool.name}`);
    if (names.has(tool.name)) throw new Error(`工具名稱重複：${tool.name}`);
    names.add(tool.name);
    assertSupported(tool.inputSchema, `${tool.name}.inputSchema`);
    if (tool.inputSchema.type !== 'object') throw new Error(`${tool.name}.inputSchema 的 type 必須是 object`);
    if (tool.outputSchema) assertSupported(tool.outputSchema, `${tool.name}.outputSchema`);
  }
  const promptNames = new Set(prompts.map(p => p.name));
  if (promptNames.size !== prompts.length) throw new Error('提示範本名稱重複');
}

/**
 * 建立 MCP 伺服器定義。
 * @param {object} def
 * @param {{name:string, title?:string, version:string}} def.info
 * @param {string} [def.instructions] 給用戶端模型的使用說明
 * @param {Array<object>} [def.tools] {name, title, description, inputSchema, outputSchema?, annotations?, handler(args, ctx)}
 * @param {Array<object>} [def.resources] {uri, name, title?, description?, mimeType, read(ctx)}
 * @param {Array<object>} [def.resourceTemplates] {uriTemplate, name, title?, description?, mimeType, read(vars, ctx)}（查無時回傳 null）
 * @param {Array<object>} [def.prompts] {name, title?, description, arguments?, render(args, ctx)}
 * @param {(err: unknown) => string|null} [def.exposeError] 可以告訴用戶端的錯誤訊息；回傳 null 表示內部錯誤（不外洩細節）
 * @param {(level: string, message: string) => void} [def.log]
 */
export function createMcpServer({
  info, instructions = '', tools = [], resources = [], resourceTemplates = [], prompts = [],
  exposeError = () => null, log = () => {},
}) {
  checkDefinitions(tools, prompts);
  const toolMap = new Map(tools.map(t => [t.name, t]));
  const promptMap = new Map(prompts.map(p => [p.name, p]));
  const resourceMap = new Map(resources.map(r => [r.uri, r]));
  const templates = resourceTemplates.map(t => ({...t, match: templateMatcher(t.uriTemplate)}));
  const capabilities = Object.freeze({
    tools: {listChanged: false},
    resources: {subscribe: false, listChanged: false},
    prompts: {listChanged: false},
  });

  const describeTool = t => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    ...(t.outputSchema ? {outputSchema: t.outputSchema} : {}),
    ...(t.annotations ? {annotations: {title: t.title, ...t.annotations}} : {}),
  });
  const describeResource = ({read, ...meta}) => meta;
  const describeTemplate = ({read, match, ...meta}) => meta;
  const describePrompt = ({render, ...meta}) => meta;

  async function callTool(params, ctx) {
    if (typeof params.name !== 'string') throw new McpError(RPC.INVALID_PARAMS, '缺少工具名稱 name');
    const tool = toolMap.get(params.name);
    if (!tool) throw new McpError(RPC.INVALID_PARAMS, `找不到工具：${params.name}`);
    const args = params.arguments ?? {};
    // 參數錯誤回報為「工具執行錯誤」而不是協定錯誤，讓用戶端的模型看得到原因並自行修正（2025-11-25 規範）
    if (!isObject(args)) return toolResult('參數必須是 JSON 物件', true);
    const input = validate(tool.inputSchema, args);
    if (!input.ok) return toolResult(`參數不正確：${formatErrors(input.errors)}`, true);

    const meta = new Map();
    try {
      const data = await tool.handler(args, {...ctx, attachMeta: (key, value) => meta.set(key, value)});
      if (tool.outputSchema) {
        const output = validate(tool.outputSchema, data);
        if (!output.ok) {
          log('error', `工具 ${tool.name} 的輸出不符合宣告的 outputSchema：${formatErrors(output.errors)}`);
          return toolResult('伺服器輸出未通過自身的格式檢查，已拒絕回傳', true);
        }
      }
      // 依規範同時附上序列化的 JSON 文字，讓不支援 structuredContent 的舊用戶端也能讀取
      return {
        content: [{type: 'text', text: JSON.stringify(data)}],
        structuredContent: data,
        ...(meta.size ? {_meta: Object.fromEntries(meta)} : {}),
      };
    } catch (err) {
      const message = exposeError(err);
      if (message === null) log('error', `工具 ${tool.name} 發生未預期錯誤：${err?.stack ?? err}`);
      return toolResult(message ?? '工具執行時發生內部錯誤', true);
    }
  }

  async function readResource(params, ctx) {
    if (typeof params.uri !== 'string') throw new McpError(RPC.INVALID_PARAMS, '缺少資源位址 uri');
    const fixed = resourceMap.get(params.uri);
    let value = null;
    let mimeType = fixed?.mimeType;
    if (fixed) value = await fixed.read(ctx);
    for (const tpl of fixed ? [] : templates) {
      const vars = tpl.match(params.uri);
      if (!vars) continue;
      value = await tpl.read(vars, ctx);
      mimeType = tpl.mimeType;
      break;
    }
    if (value === null || value === undefined) throw new McpError(RPC.RESOURCE_NOT_FOUND, `找不到資源：${params.uri}`, {uri: params.uri});
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return {contents: [{uri: params.uri, mimeType, text}]};
  }

  function getPrompt(params, ctx) {
    const prompt = promptMap.get(params.name);
    if (!prompt) throw new McpError(RPC.INVALID_PARAMS, `找不到提示範本：${params.name}`);
    const args = isObject(params.arguments) ? params.arguments : {};
    for (const arg of prompt.arguments ?? []) {
      const value = args[arg.name];
      if (value !== undefined && typeof value !== 'string') throw new McpError(RPC.INVALID_PARAMS, `參數 ${arg.name} 必須是文字`);
      if (arg.required && !value?.trim()) throw new McpError(RPC.INVALID_PARAMS, `缺少必填參數：${arg.name}`);
    }
    return {description: prompt.description, messages: prompt.render(args, ctx)};
  }

  /**
   * 建立一個連線階段：stdio 每個程序一個；HTTP 每個 Mcp-Session-Id 一個。
   * @param {object} context 綁定在這個連線上的身分與資源（例如 {user}），傳給每個 handler
   */
  function connect(context = {}) {
    const session = {initialized: false, protocolVersion: null, clientInfo: null};

    const methods = {
      initialize: params => {
        if (session.initialized) throw new McpError(RPC.INVALID_REQUEST, '這個連線已經初始化過');
        if (typeof params.protocolVersion !== 'string') throw new McpError(RPC.INVALID_PARAMS, '缺少 protocolVersion');
        session.protocolVersion = SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LATEST_VERSION;
        session.clientInfo = isObject(params.clientInfo) ? {name: String(params.clientInfo.name ?? ''), version: String(params.clientInfo.version ?? '')} : null;
        session.initialized = true;
        return {protocolVersion: session.protocolVersion, capabilities, serverInfo: info, ...(instructions ? {instructions} : {})};
      },
      ping: () => ({}),
      'tools/list': () => ({tools: tools.map(describeTool)}),
      'tools/call': params => callTool(params, context),
      'resources/list': () => ({resources: resources.map(describeResource)}),
      'resources/templates/list': () => ({resourceTemplates: templates.map(describeTemplate)}),
      'resources/read': params => readResource(params, context),
      'prompts/list': () => ({prompts: prompts.map(describePrompt)}),
      'prompts/get': params => getPrompt(params, context),
    };

    /**
     * 處理一則來自用戶端的 JSON-RPC 訊息。
     * @param {unknown} message 已解析的 JSON
     * @returns {Promise<object|null>} 回應；通知與回應訊息不需要回覆時為 null
     */
    async function handle(message) {
      if (Array.isArray(message)) return errorResponse(null, RPC.INVALID_REQUEST, '不支援 JSON-RPC 批次請求（2025-06-18 起已移除）');
      if (!isObject(message) || message.jsonrpc !== '2.0') return errorResponse(null, RPC.INVALID_REQUEST, '不是合法的 JSON-RPC 2.0 訊息');
      if (!('method' in message)) return null; // 用戶端對伺服器請求的回應；本伺服器不主動發出請求
      const hasId = 'id' in message;
      if (typeof message.method !== 'string') return hasId ? errorResponse(message.id, RPC.INVALID_REQUEST, 'method 必須是文字') : null;
      if (!hasId) return null; // 通知（notifications/initialized、notifications/cancelled 等）不回覆
      if (!isValidId(message.id)) return errorResponse(null, RPC.INVALID_REQUEST, 'id 必須是文字或整數');
      if ('params' in message && !isObject(message.params)) return errorResponse(message.id, RPC.INVALID_PARAMS, 'params 必須是物件');

      const handler = Object.hasOwn(methods, message.method) ? methods[message.method] : null;
      if (!handler) return errorResponse(message.id, RPC.METHOD_NOT_FOUND, `不支援的方法：${message.method}`);
      if (!session.initialized && !PRE_INIT_METHODS.has(message.method)) {
        return errorResponse(message.id, RPC.INVALID_REQUEST, '請先完成 initialize');
      }
      try {
        return {jsonrpc: '2.0', id: message.id, result: await handler(message.params ?? {})};
      } catch (err) {
        if (err instanceof McpError) return errorResponse(message.id, err.code, err.message, err.data);
        log('error', `處理 ${message.method} 時發生未預期錯誤：${err?.stack ?? err}`);
        return errorResponse(message.id, RPC.INTERNAL_ERROR, '伺服器內部錯誤');
      }
    }

    return Object.freeze({handle, session: () => ({...session}), context});
  }

  return Object.freeze({connect, info, capabilities, toolNames: () => [...toolMap.keys()]});
}
