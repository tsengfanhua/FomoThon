// 互通測試：以官方 MCP TypeScript SDK 的 client，連線本專案自行實作（零相依）的 MCP 伺服器。
// 涵蓋 stdio 與 Streamable HTTP 兩種傳輸；SDK 會依工具宣告的 outputSchema 驗證每一個 structuredContent。
// 官方 SDK 只列在 devDependencies：沒有安裝時整組略過（npm install 後即可執行）。
import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {ROOT, loadConfig} from '../src/config.js';
import {start} from '../src/http/server.js';
import {createTokenStore} from '../src/mcp/tokens.js';
import {baseEnv} from './helpers.js';

async function loadSdk() {
  try {
    const [client, stdio, http] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    return {Client: client.Client, StdioClientTransport: stdio.StdioClientTransport, StreamableHTTPClientTransport: http.StreamableHTTPClientTransport};
  } catch {
    return null;
  }
}

const sdk = await loadSdk();
const skip = sdk ? false : '未安裝 @modelcontextprotocol/sdk（devDependency），略過互通測試';

const SAMPLE_ARGS = {
  search_skills: {query: '機器學習'},
  get_skill: {skillId: 'SK-AI-001'},
  get_my_profile: {},
  list_competitions: {},
  recommend_competitions: {interest: 'AI 黑客松', limit: 2},
  analyze_competition: {competitionId: 'C01'},
  find_teammates: {skillId: 'SK-DSN-001', competitionId: 'C01'},
  find_advisors: {competitionId: 'C01'},
  extract_course_skills: {courseCode: 'IM260'},
  plan_goal: {goal: '我想參加 AI 黑客松，但不知道自己夠不夠格'},
  check_data_quality: {},
};

/** 用官方 client 走過全部功能：工具（含輸出驗證）、資源、資源樣板、提示範本。 */
async function exercise(client) {
  assert.equal(client.getServerVersion().name, 'fomothon');
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), Object.keys(SAMPLE_ARGS).sort());
  for (const tool of tools) {
    const result = await client.callTool({name: tool.name, arguments: SAMPLE_ARGS[tool.name]}); // SDK 會驗證 outputSchema，不符即丟出
    assert.notEqual(result.isError, true, `${tool.name}：${result.content?.[0]?.text}`);
    assert.ok(result.structuredContent);
  }
  const bad = await client.callTool({name: 'get_skill', arguments: {skillId: 'oops'}});
  assert.equal(bad.isError, true);
  const {resources} = await client.listResources();
  for (const r of resources) assert.ok((await client.readResource({uri: r.uri})).contents[0].text);
  const {resourceTemplates} = await client.listResourceTemplates();
  assert.equal(resourceTemplates.length, 2);
  const syllabus = await client.readResource({uri: 'fomothon://courses/CS101/syllabus'});
  assert.equal(JSON.parse(syllabus.contents[0].text).syllabus.code, 'CS101');
  const prompt = await client.getPrompt({name: 'prepare_for_competition', arguments: {goal: '想參加黑客松'}});
  assert.match(prompt.messages[0].content.text, /plan_goal/);
  await client.ping();
}

test('官方 SDK client × stdio 傳輸', {skip, timeout: 60_000}, async () => {
  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src/mcp/stdio.js')],
    cwd: ROOT,
    env: {PATH: process.env.PATH ?? '', ...baseEnv, FOMO_LLM_PROVIDER: 'none', FOMO_MCP_USER: 'S01'},
    stderr: 'pipe',
  });
  const client = new sdk.Client({name: 'fomothon-interop-test', version: '1.0.0'});
  await client.connect(transport);
  try {
    await exercise(client);
  } finally {
    await client.close();
  }
});

test('官方 SDK client × Streamable HTTP 傳輸（Bearer 權杖）', {skip, timeout: 60_000}, async () => {
  const ctx = await start(loadConfig({...baseEnv, PORT: '0', FOMO_MCP_HTTP: '1'}));
  const {token} = createTokenStore(ctx.app.db).issue('S01', {label: 'interop'});
  const transport = new sdk.StreamableHTTPClientTransport(new URL(`${ctx.url}/mcp`), {requestInit: {headers: {authorization: `Bearer ${token}`}}});
  const client = new sdk.Client({name: 'fomothon-interop-test', version: '1.0.0'});
  try {
    await client.connect(transport);
    assert.ok(transport.sessionId, '伺服器核發了 Mcp-Session-Id');
    await exercise(client);
    await transport.terminateSession();
  } finally {
    await client.close();
    await ctx.stop();
  }
});
