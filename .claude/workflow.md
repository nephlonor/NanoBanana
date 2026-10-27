# Phasen-Workflow (Cloud/iPhone)

Gilt für größere Vorhaben: neues Projekt, Feature oder Bugfix mit mehreren Schritten. Kleine Änderungen (ein paar Zeilen) führst du direkt aus.
Cloud-Sessions sind flüchtig: `handoff.md` und alle Änderungen immer committen und pushen, sonst sind sie weg.

Modell-IDs: Opus `claude-opus-5-5`, Sonnet `claude-sonnet-5-5`, Haiku `claude-haiku-5-5`.

## Planen (neues Projekt, Feature oder Bug)
1. **Kontext knapp holen.** Lies `CLAUDE.md`/README und die direkt betroffenen Dateien, nicht das ganze Repo. Eine alte `handoff.md` mit `STATUS: DONE` wird überschrieben.
2. **Ziel klären.** Stelle gebündelte Rückfragen, bis das Ziel klar ist (bei Bugs: erwartetes und tatsächliches Verhalten, Schritte zum Reproduzieren). Keine Annahmen raten.
3. **Rechte:** Lies `.claude/settings.json`; schlage fehlende Befehle (Build, Test, `git add/commit/push`) vor und trage sie nach Bestätigung unter `permissions.allow` ein. Nichts Destruktives (`rm -rf`, `git push --force`, `git reset --hard`).
4. **`handoff.md` im Repo-Root schreiben:**
   ```
   MODELL: <modell der Phase 1>
   STATUS: OPEN
   PUSH: ja
   # Ziel
   # Phasen
   1. <Name> – Modell | Schritte | Dateien | Prüfkriterium
   2. ...
   # Nächste Phase: 1
   # Offen
   ```
   Feature: 2–4 Phasen. Bug: 1–2 Phasen (1: reproduzieren, fehlschlagenden Test schreiben; 2: beheben, Test grün). Jede Phase passt in eine kurze Session mit klarem Prüfkriterium. Modell: Haiku für Mechanisches, Sonnet für Umsetzung, Opus für Architektur und schwierige Fehler.
5. `handoff.md` (und ggf. `.claude/settings.json`) committen und pushen.

## Ausführen
Hier gibt es keinen automatischen Koordinator. Beende den Zug mit: "Plan steht. Starte pro Phase eine neue Session auf diesem Repo, wähle das Modell aus `MODELL:` und tippe `/next-phase`." Will der Nutzer Phase 1 sofort in dieser Session, führe `/next-phase` aus.
Nach jeder Phase liest du nur die Kopfzeilen: `OPEN` weiter, `DONE` Abschlussmeldung in zwei Sätzen, `BLOCKED` Grund nennen und fragen.
