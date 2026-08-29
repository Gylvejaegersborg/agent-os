# Scoring fields reference

Fields on a `MemoryPromotionDecision` (see `src/core/types.ts` and the
`scoreEligibility` function in `src/core/memory.ts`):

| Field | Meaning |
|---|---|
| `episodicEntryId` | Which episodic memory entry this decision is about |
| `eligibilityScore` | The deterministic score — see the weights below |
| `eligible` | `true` if score >= `PROMOTION_THRESHOLD` (40) |
| `decision` | `"promoted"` if eligible, else `"held"` |

## Score weights (as of this scaffold)

- Explicit correction: **+50**
- Repetition: **+15 per repeat, capped at +45**
- Task outcome was a failure: **+10**
- Kind is "preference": **+20**
- Age decay: **-0.5 per day, capped at -30**

The model never sees or influences this function — it can only phrase
what already qualified. If curated memory contains something wrong, the
bug is either in what got written to episodic memory, or in this scoring
function — never in "the model decided to remember something."
