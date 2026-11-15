// 把評測結果寫成 Markdown 報告（對應競賽辦法附件二的揭露項目）。所有數字都來自實際執行結果。
import fs from 'node:fs';
import path from 'node:path';

const pct = val => (val === null || val === undefined ? '—' : `${Math.round(val * 1000) / 10}%`);
const row = cells => `| ${cells.join(' | ')} |`;
const table = (heads, rows) => [row(heads), row(heads.map(() => '---')), ...rows.map(row)].join('\n');

const readJson = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

/** 延伸評測：資料品質、課綱萃取準確度與多模型評比（各自由獨立的指令產生，這裡彙整重點並附連結）。 */
function extendedSection(root) {
  const dq = readJson(path.join(root, 'data', 'quality', 'latest.json'));
  const ex = readJson(path.join(root, 'eval', 'results', 'extraction.json'));
  const models = readJson(path.join(root, 'eval', 'results', 'models.json'));
  const lines = ['## 10. 延伸評測：資料品質、課綱萃取與多模型', ''];
  if (dq) {
    lines.push(`- **資料品質**（\`npm run dq\`，[報告](../../data/quality/REPORT.md)）：${dq.checks.length} 條規則、6 個面向，總分 ${dq.overall}／100，閘門${dq.gate === 'pass' ? '通過' : '未通過'}。`
      + `各面向：${dq.dimensions.map(d => `${d.label} ${d.score}`).join('、')}。有發現的規則：${dq.checks.filter(c => c.failed).map(c => `${c.id}（${c.failed} 筆）`).join('、') || '無'}。`);
  }
  if (ex) {
    const m = ex.methods.rule.micro;
    lines.push(`- **課綱技能萃取**（\`node eval/extraction.js\`，[報告](EXTRACTION.md)）：${ex.courses} 門課，共識標準答案 ${ex.gold.positives} 項（模糊項 ${ex.gold.ambiguous} 項不計分），標註者間一致性 Cohen's κ = ${ex.gold.agreement?.kappa ?? '—'}。`
      + `規則萃取 Precision ${pct(m.precision)}、Recall ${pct(m.recall)}、F1 ${pct(m.f1)}。${ex.gold.note}`);
  }
  if (models?.runs?.length) {
    lines.push(`- **多模型評比**（\`node eval/models.js\`，[報告](MODELS.md)）：${models.runs.map(r => `${r.label} 辨識 ${pct(r.intent.accuracy)}、萃取 F1 ${pct(r.extract.llm.f1)}`).join('；')}。`);
  } else {
    lines.push('- **多模型評比**（`node eval/models.js`）：評比工具已完成（錄製系統實際送出的請求，並以系統原本的檢核計分），但尚未對真實模型執行，因此沒有數字。');
  }
  return lines.join('\n');
}

export function writeReport(out, file) {
  const s = out.summary;
  const b = out.baseline.summary;
  const failed = out.cases.filter(c => !c.passed);
  const errorRows = Object.entries(s.errorCodes).map(([code, n]) => [code, String(n)]);
  const missedIntents = out.intents.filter(i => !i.ok);
  const llmMode = out.environment.brain.startsWith('llm');

  const text = `# Agent 評測報告

> 本報告由 \`npm run eval\` 自動產生，所有數字皆為實際執行結果。產生時間：${out.generatedAt}

## 1. 測試環境與成功判定

${table(['項目', '內容'], [
    ['決策模式', out.environment.brain],
    ['等級規則版本', out.environment.rulesVersion],
    ['系統日期（固定，確保可重現）', out.environment.systemDate],
    ['執行環境', `Node ${out.environment.node}／${out.environment.platform}`],
    ['測試方式', out.environment.transport],
    ['資料', out.environment.data],
    ['測試案例數', `${s.cases} 個任務案例＋${s.intentCases} 句任務辨識語句`],
  ])}

**任務成功的判定方式**：每個案例在 \`eval/cases.json\` 以 \`expect\` 寫明任務要求（最終狀態、資格判定、能力缺口、每個缺口的有效候選數、首位推薦對象、必須出現的事件等），全部達成且沒有違規推薦、重複推薦、成績外洩才算成功。安全類案例另以腳本直接驗證 API 的拒絕行為。

## 2. 整體結果

${table(['指標', '結果'], [
    ['任務成功率', `${pct(s.successRate)}（${s.passed}/${s.cases}）`],
    ['任務辨識正確率', `${pct(s.intentAccuracy)}（${out.intents.filter(i => i.ok).length}/${s.intentCases}）`],
    ['工具調用成功率', `${pct(s.toolSuccessRate)}（${s.toolCalls - s.toolErrors}/${s.toolCalls}）。${s.toolErrors} 次失敗中，${s.toolErrors - s.organicToolErrors} 次來自刻意注入故障的案例，${s.organicToolErrors} 次發生在未注入故障的案例`],
    ['重試次數／退回次數／重新規劃次數', `${s.retries}／${s.fallbacks}／${s.replans}`],
    ['人工介入率', `${pct(s.humanInterventionRate)} 的任務至少需要一次人工確認（共 ${s.humanConfirms} 次確認）`],
    ['中止率／輸入防護攔截率', `${pct(s.abortRate)}／${pct(s.blockedRate)}`],
    ['單一步驟延遲（伺服器端）', `平均 ${s.latency.stepAvgMs} ms，最大 ${s.latency.stepMaxMs} ms`],
    ['單次 API 請求延遲（用戶端量測）', `平均 ${s.latency.requestAvgMs} ms，最大 ${s.latency.requestMaxMs} ms`],
    ['完整案例耗時（含啟動伺服器）', `平均 ${s.latency.caseAvgMs} ms，最大 ${s.latency.caseMaxMs} ms`],
    ['模型／API 成本', llmMode ? `US$ ${s.costUsd}（輸入 ${s.tokensIn}、輸出 ${s.tokensOut} token；LLM 呼叫 ${s.llmCalls} 次，失敗 ${s.llmFailures} 次）` : 'US$ 0（離線規則模式不呼叫任何模型）'],
    ['違規推薦（未開放媒合、名額已滿、推薦本人）', String(s.violations)],
    ['重複推薦', String(s.duplicates)],
    ['成績外洩（媒合卡片、彙整、執行紀錄）', String(s.privacyLeaks)],
  ])}

## 3. 與基準方案比較

基準定義：${out.baseline.definition}。兩者使用相同的資料、計分規則與案例，只差在是否啟用 Agentic 機制。

${table(['指標', '固定工作流（基準）', 'Fomo鬆 Agent'], out.baseline.rows.map(r => [r.metric, r.baseline, r.agent]))}

基準未通過的案例：${out.baselineCases.filter(c => !c.passed).map(c => `${c.id}（${c.failures[0]}）`).join('、') || '無'}。

說明：通過條件只看任務結果，不以是否出現重試或重新規劃等過程事件為條件。「每個缺口至少 3 位有效候選」是團隊自訂的品質目標（\`config/level-rules.json\` 的 targetValid）。Precision@5 的分母固定為 5，而各案例人工標註的相關人選只有 1～3 位，因此上限為 0.2～0.6，應與找回率一併解讀。

與人工流程的比較尚未量測：需要真實使用者在場域中試用後才有數據，目前不提供估計值。

## 4. 測試案例明細

${table(['編號', '類別', '案例', '結果', '最終狀態', '工具調用', '人工確認', '耗時'], out.cases.map(c => [c.id, c.category, c.title, c.passed ? '通過' : `**未通過**：${c.failures.join('；')}`, c.status, String(c.toolCalls), String(c.humanConfirms), `${c.ms} ms`]))}

${failed.length ? `未通過案例共 ${failed.length} 個，原因見上表。` : '全部案例通過。'}

## 5. 任務辨識

${table(['輸入', '預期', '實際', '結果'], out.intents.map(i => [i.text, i.expected, i.actual, i.ok ? '✔' : '✖']))}

${missedIntents.length ? `辨識錯誤 ${missedIntents.length} 句。${llmMode ? '' : '規則式辨識只看關鍵詞，遇到沒有關鍵詞的口語說法會誤判；這是已知限制，啟用 LLM 辨識是為了補這一塊，但 LLM 模式的正確率尚未以真實端點量測。'}` : '全部辨識正確。'}

## 6. 錯誤分類、最壞情境與回復方式

${errorRows.length ? table(['工具錯誤代碼', '次數'], errorRows) : '本次執行沒有工具錯誤。'}

| 情境 | 系統行為 | 對應案例 |
| --- | --- | --- |
| 外部來源暫時性錯誤（逾時） | 重試（課綱最多 2 次、其他 1 次），成功後照常進行 | C01、C04 |
| 課綱持續取不到 | 退回以課名推估，證據標為「推估」且等級設上限；推估不出的技能如實列為缺口 | C02 |
| 歷屆資料取不到 | 略過難度分項並在適配度上標示缺項，不捏造數字 | C03 |
| 學生或教師資料庫斷線 | 該分支停止且不輸出任何推薦，其餘分支照常；彙整時明列失敗的資料來源 | C05、C06 |
| 競賽資格不符或已截止 | 重新規劃：改推薦資格符合的其他競賽；找不到就中止並說明 | B01、B02 |
| LLM 失效、拒答或輸出不合格 | 每個用途各自退回規則或範本（單元測試涵蓋） | — |
| 步驟內發生未預期錯誤 | 任務中止，不輸出未經查證的結果 | — |
| 步數達上限（16 步） | 任務中止 | — |

**最壞情境**：所有資料來源同時失效時，任務會完成能力盤點與競賽分析中仍可得的部分，其餘標示失敗，推薦名單為空（C06）。系統不會以猜測補上內容。

## 7. 安全測試結果

${table(['編號', '測試', '結果'], out.cases.filter(c => c.category === '安全').map(c => [c.id, c.title, c.passed ? '通過' : `未通過：${c.failures.join('；')}`]))}

另由自動化測試（\`npm test\`）涵蓋：CSRF（跨來源請求拒絕）、登入速率限制、存取碼、請求大小限制、角色權限、寫入工具需人工核發許可、LLM 輸出檢核（不存在的技能 ID、捏造的課綱出處、列舉外的動作、說明文字含事實以外的數字或人名）。瀏覽器端對端測試（\`npm run e2e\`）涵蓋 XSS：惡意作品名稱與課綱內容只以純文字顯示。

## 8. 資料來源、模型與版本管理

- **資料來源**：全部為合成示意資料（\`data/seed/\`）。課綱由系統內建的示意課綱站以 HTTP 提供，模擬校內課綱查詢頁。
- **模型與版本**：${llmMode ? out.environment.brain : '本次為離線規則模式，未使用模型。'} 支援的 LLM 設定見 README。
- **策略與 Prompt 的版本管理**：等級與媒合規則集中在 \`config/level-rules.json\`（版本 ${out.environment.rulesVersion}），每份匯出的操作紀錄都記下規則版本與決策模式；Prompt 與決策政策寫在程式碼中（\`src/agents/intent.js\`、\`brain.js\`、\`policy.js\`、\`src/inventory/extractor.js\`），隨程式碼庫以 Git 管理。
- **操作 Trace**：\`eval/results/sample-trace.json\` 是案例 A01 的完整事件紀錄（決策、工具調用、閘門、人工確認、邀請），可供查核。

## 9. 已知限制

- 案例與相關名單由團隊依合成資料自行設計與標註，不是獨立第三方的評測；成功率反映的是「系統是否符合設計要求」，不代表真實場域成效。
- 資料規模小（16 位學生、10 位教師、9 項競賽），延遲數字不能外推到正式規模。
- ${llmMode ? '本次已使用 LLM。' : 'LLM 模式（任務辨識、課綱語意萃取、下一步選擇、說明潤飾）尚未以真實模型端點評測；執行 `npm run eval -- --llm` 可取得該模式的成功率、延遲與成本。'}
- 場域驗證（真實學生與教師試用、前後比較）不在本報告範圍內。

${extendedSection(path.resolve(path.dirname(file), '..', '..'))}
`;
  fs.writeFileSync(file, text);
}
