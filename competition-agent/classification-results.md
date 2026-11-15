# HWU offline classification — hwu-rules-1

Input: repository `data/test_output_category_4934.json`, 10 announcements.
Results are rule proposals, all pending human review. No competition or skill created.

| PId | Announcement | Category | Main evidence |
|---|---|---|---|
| 108181 | 茶創盃決賽入選名單 | competition_result | 入選名單、共錄取20組 |
| 108400 | 第24屆育秀盃創意獎 | competition_call | 競賽類別、參賽對象、報名及初賽期間 |
| 108414 | 交通AI工作坊及黑客松 | needs_review | 工作坊與獨立競賽混合 |
| 108403 | 海洋大數據競賽決賽及論壇 | needs_review | 競賽與論壇混合、正文稀少 |
| 108332 | 全國技能競賽北區分區簡章 | competition_call | 競賽報名時間、寄送期限 |
| 108196 | 2027年總統科學獎 | needs_review | 提名型獎項，缺少明確競賽語境 |
| 108164 | H-Inno 2026專題競賽 | competition_call | 參賽資格、報名日期 |
| 108159 | 116年度氣候變遷創意實作競賽 | competition_call | 競賽、報名方式及期限；獎項介紹不等於結果 |
| 108149 | 2026智慧科技創客挑戰賽 | competition_update | 因前函文字重疊無法辨讀而「再次行文」 |
| 108078 | 資訊管理前瞻技術論文暨專題競賽 | competition_call | 競賽名稱、線上收件與論文截稿日期 |

Totals: call 5, update 1, result 1, needs_review 3, non_competition 0.
Synthetic offline fixtures cover non_competition as well as all remaining categories.
Reproduce with the `test_real_ten_sources` integration test. It imports the actual JSON
into temporary SQLite, asserts all ten classifications, preserves ten unlinked sources,
checks zero competitions/skills and verifies repeated classification is a no-op.
