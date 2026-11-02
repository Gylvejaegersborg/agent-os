# Egen HUD-modus — overlevering

Til agenten som jobber i **agent-os** og **BaseOStest**. Dette dokumentet
beskriver hva som er bygget (del 1), og hva som gjenstår (del 2–7), med de
reglene fra begge repoene som må holdes. Sjekkliste: `ROADMAP.md §8`.

## Hva dette er

Operatøren (Gylve) vil ha sin egen, bedre versjon av Hermes Agent sin
HUD-modus, bygget inn i sitt personlige OS. Målet er ikke en chat som svever
over skjermen, men en assistent som **lærer hvordan han jobber** og hjelper
ham å jobbe bedre, knyttet til goals og prosjekter i BaseSpace.

Hermes' HUD (Nous Research, aug. 2026, fra offentlige gjennomganger):
et flyttbart overlay med én composer-linje og siste svar over den, slås
av/på med hurtigtast, klikk går gjennom overlayet utenom selve linja,
svar-feltet er hardt begrenset i høyde, det tones ut når man slutter å lese,
og samtalen kan leveres tilbake til hovedvinduet. Viktigst: **den ser bare
skjermen når man ber den om det.** Den lærer ingenting av hva man gjør
mellom spørsmålene.

Vår versjon legger til den manglende halvdelen: en kontinuerlig,
personvernfiltrert logg over skrivebordsaktivitet som projiseres mot
BaseSpace sine goals/prosjekter og går inn i den eksisterende
minneporten (dreaming + nominasjoner).

## Del 1 — ferdig (denne commiten)

| Hva | Hvor |
|---|---|
| Windows-sensor, kun stdlib: forgrunnsvindu + inaktivitet hvert sekund, sender ferdige spenn hvert 15. s, offline-spool, deler spenn hvert 60. s | `desktop/sensor/sensor.py` |
| Personvernregler: skjulte apper → `(private)`, private titler (inkognito, nettbank), apper der kun navn lagres (mail, chat), redigering av e-post/fødselsnr/kontonr | `desktop/sensor/privacy.example.json` → `privacy.json` (gitignored) |
| Strøm `desktop:YYYY-MM-DD` i event-loggen, dedup på span-id, validering (kun `active`/`idle`, maks 1 t, maks 500 per batch) | `src/core/desktop.ts` |
| Projeksjon: tidslinje (sammenslått), tid per app, per BaseSpace-prosjekt/goal (alle signifikante ord i navnet må stå i tittelen), appbytter, fokusblokker ≥25 min, tekst-digest | `desktopTimeline`, `desktopDaySummary`, `renderDesktopDigest` |
| Live-signal: `desktop.focus` på bussen ved vindusbytte (ikke hvert 15. s) + `getDesktopFocus()` | `src/core/desktop.ts` |
| Gateway: `POST /desktop/spans`, `GET /desktop/now`, `GET /desktop/timeline?day=`, `GET /desktop/summary?day=` | `src/gateway/server.ts` |
| MCP-verktøy `desktop_activity` (for Claude Code i Workbench-terminalen) | `src/gateway/mcp.ts` |
| Tester | `npm run test-desktop` (30), `python desktop/sensor/test_sensor.py [gateway-url]` |

Bruk og detaljer: `desktop/README.md`.

**Ikke verifisert:** selve Windows-kallene (ctypes: `GetForegroundWindow`,
`QueryFullProcessImageNameW`, `GetLastInputInfo`). Alt annet er testet, også
ende-til-ende mot en kjørende gateway. Første steg på operatørens maskin:
`python desktop\sensor\sensor.py --dry-run`.

**Kjente småsvakheter:** fokusblokk-tider i digesten skrives i UTC (`HH:MMZ`)
— bør være lokal tid. Inaktivitet som starter rett etter en 60-s-deling kan
telles opptil ~60 s som aktiv. Dedup-cachen i `desktop.ts` holder id-er per
dag i minnet så lenge gatewayen kjører.

## Faste regler (fra CLAUDE.md, ROADMAP og del 1) — ikke bryt disse

1. **Aldri** tastetrykk, skrevet tekst, utklippstavle eller lyd i
   aktivitetsloggen. Skjermbilder kun på eksplisitt forespørsel («dette»),
   aldri lagret i strømmen. Gatewayen skal fortsatt avvise andre span-typer.
2. Gatewayen har ingen auth og lytter på `127.0.0.1`. HUD-vinduet og
   sensoren snakker kun lokalt. Ingen porter ut.
3. Modellen skriver aldri kuratert minne direkte — kun episodisk +
   nominasjon, og dreaming-porten + operatørens godkjenning avgjør.
4. Kun **én** EventSource i BaseSpace (`subscribeToEvents` i
   `sessionClient.ts`). HUD-ruten skal bruke den, ikke åpne en ny.
5. Hold ting på det sammenkoblende laget: goals → prosjekter → todos/notater,
   og sesjons-`focus`. HUD-samtaler skal være vanlige sesjoner, ikke en
   egen chat ved siden av.
6. Agenter ser bare verktøy de kan bruke; hold per-kall-konteksten slank.
   Nye verktøy for lesing skal være tillatt i plan mode, skrivende ikke.
7. Hendelseslogg først: ny tilstand er en projeksjon over strømmer, ikke en
   egen tabell.
8. Utadrettede handlinger går gjennom Approvals. Ingenting her er
   utadrettet i dag — hvis HUD-en skal klikke/skrive i andre apper senere,
   er det en approval-sak.

## Del 2 — agentene kan lese aktiviteten  `[core]`

- Nytt read-only-verktøy `desktop` i tool-registry
  (`src/core/tool-registry.ts`), args `{ day?: "YYYY-MM-DD" }`, returnerer
  samme tekst som MCP-verktøyet (`renderDesktopDigest` + nåværende fokus).
  Legg det bare til agenter som faktisk trenger det (Hemera + den som
  eier læringsløkka), ikke alle.
- Ikke blokkert i plan mode.
- Test: verktøyet er registrert, returnerer digest, er tilgjengelig i plan
  mode.

## Del 3 — læringsløkka  `[core]`

Mål: dagens aktivitet blir til *mønstre* i minnet, ikke rålogg.

- En kveldsautomasjon (cron via `scheduler.ts`, f.eks. 22:00 lokal tid)
  som **først bygger et kodebasert sammendrag** (`desktopDaySummary`) og
  sammenligner med de forrige 7 dagene. Kjør bare en modelltur hvis noe er
  nytt eller endret (samme prinsipp som `review.ts`): f.eks. ny tidsbruk på
  et prosjekt, ingen fokusblokker tre dager på rad, mye tid som ikke
  matcher noe goal.
- Modellturen skriver `writeEpisodic` med `kind: "fact"` / `"outcome"` /
  `"skill-candidate"` (f.eks. «jobber mest med musikk etter kl. 21»,
  «fokusblokker i FL Studio er typisk 40–60 min»), og nominerer det som
  virker varig. Dreaming-sveiperen og MemoryTab tar resten — ingen ny
  godkjenningsflyt.
- Uttrykkelige korrigeringer fra operatøren i HUD-en («nei, det var ikke
  jobb») → `kind: "correction"`, `wasExplicitCorrection: true`.
- Vurder å lagre ukessammendrag som egen projeksjon (`desktop-week:YYYY-Www`)
  hvis 7-dagers sammenligningen blir treg å regne ut hver kveld.
- Test: stille dag → ingen modelltur; endret mønster → episodisk skrevet;
  ingenting havner i kuratert minne uten dreaming.

## Del 4 — coach  `[core]` `[UI]`

- Ukentlig, kodebygget digest i samme stil som `core/review.ts`: tid mot
  aktive goals, fragmenterte dager (mange bytter, ingen fokusblokker),
  tid som ikke tjener noe goal, goals uten tid på lenge.
- Modelltur kun når noe trenger oppmerksomhet og har endret seg; svaret
  legges som notat/todo i BaseSpace via overlayet (`addOverlayItem`), koblet
  til riktig goal — ikke som en egen varsel-kanal.
- `[UI]`: vis ukens tall på goal-/prosjektsidene («3 t 20 m denne uka»),
  hentet fra `/desktop/summary`. Lag gjerne `GET /desktop/week?week=`.

## Del 5 — HUD-vinduet  `[UI]`

- Nytt skall: lite Tauri- (foretrukket, lettere) eller Electron-vindu på
  Windows. Alltid øverst, gjennomsiktig, flyttbart, klikk går gjennom alt
  utenom composer-linja og svarfeltet. Global hurtigtast for vis/skjul
  (f.eks. Ctrl+Shift+Space — ikke kollider med Workbench-snarveier i
  `useSectionShortcuts.ts`). Tones ned etter noen sekunder uten mus over.
  Svarfeltet hardt begrenset i høyde.
- Innhold: en `/hud`-rute i BaseOStest (ny `src/features/hud/`), lastet av
  skallet fra Vite-serveren. Gjenbruk `useAgentOsChat` og komponentene fra
  `ConversationPane.tsx` der det går. Gatewayen nås som i resten av
  BaseSpace (`/agent-os`-proxyen / `VITE_AGENT_OS_GATEWAY_URL`).
- Sesjon: HUD-en har én pågående sesjon. Når `desktop.focus` sier at
  vinduet matcher et prosjekt/goal, sett sesjonens focus
  (`PUT /sessions/:id/focus`) — da får agenten goal-kjeden, neste steg og
  åpne todos automatisk. Vis «Tjener: …» i HUD-en så operatøren ser og kan
  overstyre det.
- Hver tur sender med nåværende fokus (app + tittel) som kort kontekst.
- «Åpne i Workbench»-knapp som hopper til samme sesjon i hovedvinduet
  (samtalen leveres tilbake, som i Hermes).
- Ikke bygg egen hotkey-/overlay-kode i Python (Clicky-forken er forlatt).

## Del 6 — trykk-for-å-snakke  `[UI]`

- Tale-til-tekst kjører lokalt på operatørens maskin (mikrofonen er der).
  ROADMAP §5 peker på VoiceStudio (AGPL — kun som uendret separat tjeneste
  over HTTP). Alternativ: en liten lokal faster-whisper-tjeneste med samme
  OpenAI-kompatible `/v1/audio/transcriptions`-form, så begge kan byttes.
- HUD: hold hurtigtast → ta opp → transkriber → send som vanlig tur. Samme
  vei brukes for mikrofonknappen i `ConversationPane.tsx` (som i dag tar opp
  `.webm` ingen agent hører).
- Ingen TTS — operatøren vil ikke ha tale tilbake.
- Talen lagres aldri i aktivitetsstrømmen; kun den transkriberte teksten
  som en vanlig melding i sesjonen.

## Del 7 — «dette»  `[core]` `[UI]`

- På forespørsel (knapp eller «hva er dette?») tar HUD-skallet skjermbilde
  av skjermen/vinduet i front.
- Små lokale modeller: skjermbilde → OCR → tekst i turen (Tesseract eller
  Windows' innebygde OCR i skallet). Bildet selv sendes kun når agenten er
  rutet til `claude-cli`, og krever multimodal-punktet i ROADMAP
  (`ModelMessage` med bilder).
- Skjermbildet lagres ikke; kun det som havner i turens melding.
- Senere/valgfritt: peke på ting på skjermen (tegne en markør i
  HUD-overlayet). Klikke/skrive i andre apper er utenfor scope uten
  approval-flyt.

## Rekkefølge

2 → 3 → 5 → 6 → 4 → 7. Del 2 er liten og låser opp 3; HUD-vinduet (5) har
verdi alene selv før tale og «dette».
