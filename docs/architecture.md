# Agent-Native OS — Architecture Sketch v0.1

Grunnlag: syntese av 6 reelle harnesser (Hermes, Claude Code, OpenClaw, Codex,
DeepSeek Harness, Pi). Se samtale-historikk for kildehenvisninger per primitiv.

Prinsipp: **Harness = prosessmodell for intelligens. OS = prosessmodell for
alt annet.** Alt annet i dette dokumentet er bygget på étt fundament:

> **Alt er en projeksjon over en append-only event-logg.**
> Ikke separate tabeller for Session/Task/Memory — én hendelsesstrøm per
> stream-id, og alt annet (aktiv sesjon, task-status, minnetilstand,
> skill-katalog) er *utledet* ved å spille av hendelser, ikke separat
> vedlikeholdt tilstand. Dette er mønsteret Hermes (SQLite), OpenClaw
> (SQLite+revisjon), Pi (JSONL-trær) og DeepSeek Harness (JSONL/SQLite)
> alle konvergerer på uavhengig av hverandre.

---

## 0. Event Log — fundamentet alt annet bygges på

```typescript
interface Event {
  id: string           // ULID — sorterbar, tidsstemplet
  streamId: string      // hvilken strøm (session/task/agent/flow)
  type: string           // "agent.turn.start", "tool.call.end",
                          // "memory.episodic.write", "task.status.changed", ...
  timestamp: string
  payload: Record<string, unknown>
  causedBy?: string       // event-id som utløste denne (kausalitetskjede)
}

// Alt nedenfor (Session, Task, MemoryState, SkillCatalog) er PROJEKSJONER:
// function project<T>(streamId: string, reducer: (state: T, e: Event) => T): T
```

**Hvorfor dette betyr noe i praksis:** compaction, resume, replay, audit og
"hvorfor gjorde agenten X" (observability) blir gratis — du spiller bare av
et prefiks av loggen på nytt — i stedet for separat vedlikeholdt kode for
hver av dem, som er det de fleste harnesser endte opp med å bygge separat
og så senere måtte holde synkronisert.

---

## 1. Agent vs. Worker — atskilt identitet fra eksekvering

```typescript
interface Agent {
  id: string
  identity: { name: string; persona: string }   // system-prompt/karakter
  memory: MemoryRef                              // peker til minne-namespace
  policy: PermissionPolicy
  defaultModel: ModelRef
  skillCatalog: SkillRef[]
}

interface Worker {
  id: string
  kind: 'local-shell' | 'docker' | 'ssh' | 'browser' | 'gpu-remote'
      | 'acp:claude-code' | 'acp:codex'   // ekte cross-harness eksekvering
      | 'acp:dsh'                          // DeepSeek Harness som barn
  capabilities: string[]
  sandbox: SandboxPolicy
}
```

DeepSeek Harness beviser dette er reelt og gjør nytte for seg: en Agent kan
delegere til en Worker som *er* en helt annen harness (ekte Claude Code eller
Codex-instans) via en protokoll (ACP-stil), ikke et internt funksjonskall.
Det betyr: din OS's "Agent" trenger aldri å vite om Worker-en er en lokal
subprocess, en Docker-container, eller en helt annen AI-harness.

---

## 2. Task / Flow / Automation / Standing Order — OpenClaws 4-veis splitt

Dette er den mest gjennomarbeidede modellen av de seks undersøkte, og den
holder opp mot press. IKKE forenkle til ett "Task"-objekt (Claude Codes
enklere graf) — de fire tingene har genuint forskjellige garantier.

```typescript
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'
                 | 'timed_out' | 'cancelled' | 'lost'

/** "Hva skjedde" — ledger-oppføring, opprettes automatisk for alt
 *  detached arbeid (subagent, cron-kjøring, CLI-operasjon). Vanlig
 *  chat/heartbeat-turer oppretter IKKE en Task. */
interface Task {
  id: string
  type: 'subagent' | 'cron' | 'cli' | 'user-request' | 'flow-step'
  agentId: string
  workerId?: string
  parentTaskId?: string
  flowId?: string
  status: TaskStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  input: Record<string, unknown>
  output?: Record<string, unknown>
  notifyPolicy: 'immediate' | 'digest' | 'silent'
  deliveryStatus?: 'queued' | 'delivered' | 'blocked'
}

/** "Hvordan koordineres flere steg" — orkestrering OVER flere Task-er.
 *  Egen revisjonsteller for optimistic concurrency (som OpenClaws
 *  flow_runs-tabell) — en forsinket skriving avvises som konflikt i
 *  stedet for å stille overskrive tilstand. */
interface Flow {
  id: string
  kind: 'managed' | 'mirrored'   // managed = eksplisitt steg-kontroller,
                                  // mirrored = 1:1 wrapper rundt én task
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  steps: FlowStep[]
  revision: number
}

interface FlowStep {
  id: string
  taskId?: string           // Task-en som backer dette steget, når spawnet
  dependsOn: string[]        // step-id-er
  status: TaskStatus
}

/** "Når trigges det" — timing-mekanismen, ikke selve arbeidet. */
interface Automation {
  id: string
  trigger:
    | { kind: 'cron'; expr: string }
    | { kind: 'event'; eventType: string; filter?: Record<string, unknown> }
    | { kind: 'webhook'; path: string }
  agentId: string
  promptTemplate: string
  enabled: boolean
}

/** "Hvilken autoritet er gitt" — IKKE et dataobjekt. Naturlig-språk-tekst
 *  i et alltid-injisert dokument (f.eks. STANDING_ORDERS.md), tolket av
 *  agenten selv ved kjøretid. Kombineres med en Automation for håndhevet
 *  timing (f.eks. en cron-jobb hvis prompt bare sier "utfør iht.
 *  standing orders"). */
// -> Ingen egen type. Lever som tekst i agentens kontekst-injeksjon.
```

**To scheduling-modi** (fra OpenClaw — eksplisitt navngitt trade-off,
ikke én scheduler-abstraksjon):
- **Automations** — presis timing, isolert kontekst (cron/webhook)
- **Heartbeat** — upresis timing (f.eks. hvert 30. min), men full
  hovedsesjons-kontekst — for "sjekk innboksen"-type arbeid

---

## 3. Minne + Læring — Hermes' umiddelbarhet + OpenClaws sikkerhet

**Dette er punktet du ba meg utdype.** Problemet de to modellene løser er
forskjellig:
- Hermes: agenten skriver minne/skills *direkte*, i sanntid — maks
  umiddelbarhet, men ingen beskyttelse mot at én rar samtale eller én
  hallusinert "innsikt" forurenser permanent minne for godt.
- OpenClaw: *ingenting* skrives til permanent minne uten å gå gjennom en
  deterministisk, etterprøvbar godkjenningsprosess ("dreaming") — trygt,
  men ikke umiddelbart; en innsikt fra i dag virker ikke før neste
  konsolideringsrunde.

**Løsningen: tre lag, med "dreaming" som den eneste veien inn i lag 1.**

```typescript
// === LAG 1: Curated — alltid injisert, hardkappet, KUN skrevet av dreaming ===
interface CuratedMemory {
  agentId: string
  content: string        // MEMORY.md-ekvivalent, f.eks. maks 2500 tegn
  userProfile: string    // USER.md-ekvivalent, f.eks. maks 1500 tegn
  lastConsolidatedAt: string
  provenance: MemoryProvenance[]   // revisjonsspor: hvilke episodiske
                                     // oppføringer -> denne linjen, og hvorfor
}

interface MemoryProvenance {
  curatedLineHash: string
  sourceEpisodicIds: string[]
  promotionReason: 'dreaming-consolidation' | 'explicit-user-correction'
  score: number   // den deterministiske skåren som rettferdiggjorde forfremmelse
}

// === LAG 2: Episodic — FAST PATH, skrives direkte, i sanntid, av agenten ===
// Dette er det som bevarer Hermes' "agenten blir bedre med deg NÅ"-følelse.
interface EpisodicEntry {
  id: string
  agentId: string
  timestamp: string
  content: string                 // en observasjon agenten la merke til
  kind: 'preference' | 'correction' | 'fact' | 'outcome' | 'skill-candidate'
  sourceSessionId: string
  wasExplicitCorrection: boolean  // brukeren korrigerte agenten direkte
  repetitionCount: number          // hvor mange ganger har noe lignende dukket opp
  taskOutcome?: 'success' | 'failure'
}
// Agenten kan skrive denne live, akkurat som memory-verktøyet i Hermes i dag.
// INGEN forsinkelse her — dette er det som holder "agenten lærer meg å kjenne"
// -følelsen intakt fra første sekund.

// === LAG 3: Skill-utkast — også fast path ===
interface SkillDraft {
  id: string
  proposedByAgentId: string
  skillName: string
  content: string                  // utkast til SKILL.md
  triggerEvidence: string[]        // episodiske oppføringer som motiverte dette
  status: 'draft' | 'promoted' | 'rejected'
}

// === DREAMING-PIPELINEN — bakgrunnsjobb, kjørt som en Automation ===
// (f.eks. daglig, som en scheduled Task av type 'cron')
interface DreamingPass {
  id: string
  ranAt: string
  episodicEntriesReviewed: number
  promotions: MemoryPromotionDecision[]
  skillPromotions: SkillPromotionDecision[]
}

interface MemoryPromotionDecision {
  episodicEntryId: string
  eligibilityScore: number   // DETERMINISTISK funksjon — IKKE fri LLM-dømmekraft
  eligible: boolean            // score >= terskel
  llmSummary?: string          // LLM brukes KUN til fraseformulering/sammenslåing
                                 // hvis eligible=true — aldri til å BESLUTTE
  decision: 'promoted' | 'held' | 'discarded'
}

interface SkillPromotionDecision {
  skillDraftId: string
  eligibilityScore: number
  decision: 'promoted' | 'held' | 'rejected'
}
```

**Den deterministiske skår-funksjonen** (kjernen i "dreaming"-sikkerheten —
modellen får ALDRI lov til å bestemme hva som er verdt å huske, bare å
fraseformulere det som allerede er kvalifisert av kode):

```typescript
function scoreEligibility(entry: EpisodicEntry): number {
  let score = 0
  if (entry.wasExplicitCorrection) score += 50   // korreksjoner veier tyngst
  score += Math.min(entry.repetitionCount * 15, 45)  // gjentatte mønstre
  if (entry.taskOutcome === 'failure') score += 10    // feil er lærerike
  if (entry.kind === 'preference') score += 20
  const ageDays = daysSince(entry.timestamp)
  score -= Math.min(ageDays * 0.5, 30)   // ukorroborerte observasjoner falmer
  return score
}

const PROMOTION_THRESHOLD = 40
```

**Hva dette gir deg konkret:**
1. Agenten fanger fortsatt opp ting *i sanntid* under enhver samtale
   (episodic write) — akkurat som i dag, ingen tap av umiddelbarhet.
2. Ingenting du sier én gang, i én rar samtale, havner i permanent minne
   automatisk — det må enten være en eksplisitt korreksjon (høy vekt med
   én gang) eller dukke opp flere ganger (repetisjon bygger skår over tid).
3. Full revisjonsspor: for enhver linje i MEMORY.md kan du spørre "hvorfor
   husker du dette" og få faktiske kildeoppføringer og skår tilbake —
   ikke bare "modellen bestemte det".
4. Samme mønster for skills: et forslag til skill blir et `SkillDraft`
   umiddelbart (bevarer refleksen "dette vil jeg gjøre igjen → lag skill"),
   men graduerer til en faktisk alltid-lastet skill kun via samme
   dreaming-gate — unngår at skill-katalogen fylles opp med
   engangs-særtilfeller fra én enkelt oppgave.

---

## 4. Hooks — deterministisk lag, atskilt fra modellens dømmekraft

```typescript
type HookEvent =
  | 'agent.turn.start' | 'agent.turn.end'
  | 'tool.before' | 'tool.after'
  | 'session.start' | 'session.end'
  | 'compaction.before' | 'compaction.after'
  | 'task.created' | 'task.completed' | 'task.failed'
  | 'memory.dreaming.start' | 'memory.dreaming.complete'   // gjør dreaming hookbar
  | 'skill.draft.created' | 'skill.promoted'

interface Hook {
  event: HookEvent
  handler:
    | { kind: 'shell'; command: string }
    | { kind: 'http'; url: string }
    | { kind: 'agent-prompt'; prompt: string }
  canBlock: boolean   // decision-hook (kan avvise) vs. observe-only
}
```

Design-regel fra Claude Code (den klareste artikuleringen av dette):
**harnessen kjører hooks, ikke modellen** — alt som "må skje" hører hjemme
her, ikke som en instruksjon modellen forhåpentligvis følger.

---

## 5. Skills — implementer den åpne spesifikasjonen, ikke ditt eget format

```typescript
interface Skill {
  name: string
  description: string       // alltid resident i kontekst (progressive disclosure)
  content: string             // full SKILL.md-kropp, lastet ved behov
  frontmatter: {
    disableModelInvocation?: boolean
    allowedTools?: string[]
    contextFork?: boolean     // kjør i isolert subagent
  }
  provenance: 'human-authored' | 'agent-drafted' | 'dreaming-promoted'
}
```

Pi er allerede kryss-kompatibel med Claude Code og Codex sine skill-mapper
direkte fordi alle implementerer samme åpne spec (agentskills.io). Bygg
mot den spesifikasjonen — da arver du et helt økosystem av skills gratis.

---

## 6. Permissions / Sandboxing — to atskilte lag, ikke ett

```typescript
interface PermissionPolicy {
  // LAG A: pre-eksekvering, modell-input-basert, GAMEABLE
  toolRules: { tool: string; decision: 'allow' | 'ask' | 'deny' }[]
}

interface SandboxPolicy {
  // LAG B: OS-håndhevet, holder UANSETT hva modellen valgte å kjøre
  filesystemScope: 'workspace-only' | 'workspace+temp' | 'unrestricted'
  networkDomains: string[] | 'unrestricted'
  mode: 'host' | 'container' | 'micro-vm'
}
```

Claude Codes eget prinsipp: *"permission rules can be circumvented by a
misleading command string, but the sandbox boundary holds regardless of
what the model chose to run."* Bygg begge lagene fra dag én — ikke bare
det ene og anta det dekker det andre.

---

## 7. Agent-filsystemet — eksponer denne verdenen som et faktisk namespace

```
/agent
  /identity/<agentId>.json
  /memory/<agentId>/
    curated/MEMORY.md
    curated/USER.md
    episodic/YYYY-MM-DD.jsonl
    drafts/skill-candidates/*.md
    dreaming-log/*.json          # revisjonsspor for hver forfremmelse
  /skills/<skill-name>/SKILL.md
  /tasks/<taskId>/{log,output,checkpoint}
  /flows/<flowId>/state.json
  /automations/<automationId>.json
  /sessions/<sessionId>.jsonl     # den append-only event-loggen
  /workers/<workerId>/policy.json
```

---

## Sammendrag: hva som er nytt vs. rent kopiert

| Del | Kilde | Endring for din OS |
|---|---|---|
| Event log som fundament | Konvergens (alle 6) | Gjør det eksplisitt arkitektonisk prinsipp, ikke tilfeldig implementasjonsdetalj |
| Agent/Worker-splitt | DeepSeek Harness (bevist i praksis) | Ta rett inn, inkl. ACP-stil cross-harness workers |
| Task/Flow/Automation/StandingOrder | OpenClaw (verifisert ekte, dypest gjennomtenkt) | Ta rett inn i stedet for å forenkle |
| Minne: fast-path episodic | Hermes | Behold umiddelbarheten |
| Minne: dreaming-gate | OpenClaw | Legg til som ENESTE vei til permanent minne |
| **Hybrid: episodic write ALLTID live, promotion ALLTID gated** | **Ny syntese** | **Dette er det som svarer på "jeg vil at agenten skal bli bedre med meg" UTEN OpenClaws treghet eller Hermes' sårbarhet** |
| Skills-format | agentskills.io (konvergert standard) | Bygg mot spec, ikke eget format |
| Permissions vs. sandbox | Claude Code (klarest artikulert) | To atskilte lag fra dag én |
| Hooks | Claude Code + DeepSeek Harness (cross-compat) | Deterministisk, harness-kjørt, ikke modell-avhengig |
