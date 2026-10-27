---
description: Nächste Phase aus handoff.md ausführen (nach /clear oder als eigene Session)
---
1. Lies `handoff.md` im Projektordner. Nichts anderes, bis du es brauchst. Kopfzeilen: `MODELL:`, `STATUS:`, `PUSH:`.
2. `STATUS: DONE` → melde das in einem Satz und stoppe. `STATUS: BLOCKED` → nenne den Grund und stoppe.
3. Passt `MODELL:` nicht zum laufenden Modell, sag es in einem Satz. Arbeite trotzdem, wenn der Wechsel nicht möglich ist.
4. Führe genau die eine Phase "Nächste Phase" aus und prüfe sie am Prüfkriterium.
5. Bei Erfolg: `git add` der betroffenen Dateien, `git commit` (Phase und Ergebnis in der Nachricht). Bei `PUSH: ja` danach `git push`.
6. Überschreibe `handoff.md`:
   - `MODELL:` Modell der folgenden Phase (opus | sonnet | haiku)
   - `STATUS:` `OPEN`, wenn Phasen folgen; `DONE`, wenn alles fertig; `BLOCKED`, wenn das Prüfkriterium scheitert oder etwas fehlt (Grund unter "Offen")
   - `PUSH:` unverändert übernehmen
   - Abschnitte: Erledigt (kurz), Nächste Phase (Schritte, Dateien, Prüfkriterium), Offen
   Danach `handoff.md` committen und pushen (Cloud-Sessions sind flüchtig).
7. Stoppe. Keine Zusammenfassung über die Datei hinaus.

Existiert keine `handoff.md`: lies `.claude/workflow.md` und starte dort mit dem Planen.
$ARGUMENTS
