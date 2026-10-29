# Hardware

Design files for the physical station. Design: midterm report Chapter 6.

**Status:** planned. Schematic capture is the next step for both boards.

| Folder | What goes here | Owner | Report |
|---|---|---|---|
| `pcb/main_board/` | ESP32-S3 board: schematic, layout, Gerbers, bill of materials | Charanjith | §6.3, §6.9 |
| `pcb/power_board/` | Battery bus, regulators and switched rails: schematic, layout, Gerbers, bill of materials | Charanjith / Egla | §6.2, §6.9 |
| `enclosure/` | Enclosure CAD, printed sleeves, top cap, battery cradle, electronics tray (source files + printable exports) | Kam | §6.10 |

## Rules

- Commit the **source** design files (the files you open to edit), not only exports, so anyone can change the design later.
- Put manufacturing exports (Gerbers, STLs) in a subfolder named `exports/` inside the board or enclosure folder.
- When a board is sent to fabrication, note the date and revision in a commit message, for example `main_board rev A sent to fab`.
