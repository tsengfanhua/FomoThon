# Offline skill extraction/review verification

All database writes were made to temporary SQLite files. Existing Competition Demo,
local ESCO database and original CSV were not migrated or modified.

## Real Yushow announcement

Fixture: repository data/test_output_category_4934.json, PId 108400. Test imports all 10
real announcements, classifies them and explicitly confirms/links the selected announcement
in a temporary database. A test-only FixedMockExtractor([]) produces:

- completed run, proposal_count=0; competition_skills remains empty;
- repeated extraction returns the same run and invokes the mock only once;
- the other 9 announcements remain unlinked;
- no synthetic content is substituted into the real announcement.

This is a conservative fixed offline test, not an actual model extraction or a claim
that the competition has no skill requirements in its full competition rules.

## Synthetic positive example

Clearly marked test-only source:
`【合成測試，非真實公告】所有參賽者必須具備程式設計技能。報名截止12月1日。`

1. Human-review test helper confirms and links the synthetic announcement.
2. Fixed mock returns explicit/competition_wide claim 程式設計 with exact quote and offsets.
3. Controlled dictionary searches computer programming in temporary ESCO catalogue
   populated with actual taxonomy records; no URI is invented.
4. Candidate is computer programming:
   `http://data.europa.eu/esco/skill/21d2f96d-35f7-4e3f-9745-c533d2dd6e97`.
5. Test human chooses that URI, core, reviewer=test-human and a review note.
6. Acceptance creates one competition_skills row and changes proposal revision 1 -> 2,
   pending -> accepted, in one transaction. Evidence JSON v1 retains the quote, source,
   content fingerprint, scope, URI and human review details.
7. Identical repeat at revision 2 is a no-op. Two valid sources merge two evidence items
   into one skill row. Importance conflicts, stale evidence and plain text are preserved
   and rejected for automatic overwrite.

## Validation

112 offline tests passed: 37 new skill workflow/migration cases, 63 existing core tests
(version assertions updated), and 12 unchanged crawler tests. Covers failed/empty runs,
literal quote checks, AI-theme non-inference, scope and evidence levels, URI validation,
source/catalogue changes, idempotence, merge conflicts, atomic rollback and v2 -> v3
preservation of all four original tables. No API/online tests executed.
